import {
  CollectCommentsInput,
  CollectCommentsOutput,
  CommentBatchPayload,
  CommentPageSnapshot,
  DataCollectorInput,
  DataCollectorOutput,
  GetFinalStreamMetadataOutput,
  GetStreamMetadataOutput,
  NormalizedComment,
  SendRegisteredBatchesInput,
  SendRegisteredBatchesOutput,
} from './contracts';
import { DataCollectorError } from './errors';
import { getRequired, ObjectStore, writeFirstWriterWins, writeImmutable } from './outbox';
import { MessageQueue } from './queue';
import { canonicalJson, pageId, sha256, splitBatches, sqsJson } from './serialization';
import { laterTimestamp, normalizeTimestamp } from './timestamps';
import { YouTubeClient } from './youtube';

export interface OperationDependencies {
  readonly youtube: YouTubeClient;
  readonly store: ObjectStore;
  readonly queue: MessageQueue;
  readonly maxMessageBodyBytes: number;
  readonly now: () => Date;
  readonly remainingTimeInMillis?: () => number;
}

const MIN_EXTERNAL_OPERATION_BUDGET_MS = 12_000;

function requireTimeBudget(dependencies: OperationDependencies): void {
  if (dependencies.remainingTimeInMillis &&
      dependencies.remainingTimeInMillis() <= MIN_EXTERNAL_OPERATION_BUDGET_MS) {
    throw new DataCollectorError('TIME_BUDGET', 'Insufficient time remains for another external operation');
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DataCollectorError('OUTBOX_INTEGRITY', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function youtubeRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DataCollectorError('UNEXPECTED', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new DataCollectorError('OUTBOX_INTEGRITY', `${label} has an invalid schema`);
  }
}

function utf8Json(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) { throw new DataCollectorError('OUTBOX_INTEGRITY', `${label} is not valid UTF-8`, undefined, undefined, { cause: error }); }
  try { return JSON.parse(text) as unknown; }
  catch (error) { throw new DataCollectorError('OUTBOX_INTEGRITY', `${label} is not valid JSON`, undefined, undefined, { cause: error }); }
}

function parseSnapshot(bytes: Uint8Array): CommentPageSnapshot {
  const value = record(utf8Json(bytes, 'Snapshot'), 'Snapshot');
  exactKeys(value, ['schemaVersion', 'streamId', 'collectionJobId', 'youtubeLiveChatId', 'requestPageToken',
    'responseNextPageToken', 'observationStartedAt', 'pollingIntervalMillis', 'offlineAt', 'comments'], 'Snapshot');
  if (value.schemaVersion !== 'comment-page-v1' || typeof value.streamId !== 'string' ||
      typeof value.collectionJobId !== 'string' || typeof value.youtubeLiveChatId !== 'string' ||
      !(value.requestPageToken === null || typeof value.requestPageToken === 'string') ||
      typeof value.responseNextPageToken !== 'string' || typeof value.observationStartedAt !== 'string' ||
      typeof value.pollingIntervalMillis !== 'number' || !Number.isSafeInteger(value.pollingIntervalMillis) ||
      value.pollingIntervalMillis < 0 || !(value.offlineAt === null || typeof value.offlineAt === 'string') ||
      !Array.isArray(value.comments)) {
    throw new DataCollectorError('OUTBOX_INTEGRITY', 'Snapshot has invalid field types');
  }
  const comments = value.comments.map((item, index) => {
    const comment = record(item, `Snapshot comments[${index}]`);
    exactKeys(comment, ['commentId', 'text', 'publishedAt'], `Snapshot comments[${index}]`);
    if (typeof comment.commentId !== 'string' || comment.commentId.length === 0 || typeof comment.text !== 'string' ||
        typeof comment.publishedAt !== 'string') throw new DataCollectorError('OUTBOX_INTEGRITY', 'Snapshot comment is invalid');
    return { commentId: comment.commentId, text: comment.text,
      publishedAt: normalizeTimestamp(comment.publishedAt, 'publishedAt') };
  });
  return {
    schemaVersion: 'comment-page-v1', streamId: value.streamId, collectionJobId: value.collectionJobId,
    youtubeLiveChatId: value.youtubeLiveChatId, requestPageToken: value.requestPageToken,
    responseNextPageToken: value.responseNextPageToken,
    observationStartedAt: normalizeTimestamp(value.observationStartedAt, 'observationStartedAt'),
    pollingIntervalMillis: value.pollingIntervalMillis,
    offlineAt: value.offlineAt === null ? null : normalizeTimestamp(value.offlineAt, 'offlineAt'), comments,
  };
}

function normalizeComments(items: readonly unknown[]): readonly NormalizedComment[] {
  const comments = new Map<string, NormalizedComment>();
  for (const itemValue of items) {
    const item = youtubeRecord(itemValue, 'YouTube item');
    const snippet = youtubeRecord(item.snippet, 'YouTube item.snippet');
    if (snippet.type !== 'textMessageEvent') continue;
    const details = youtubeRecord(snippet.textMessageDetails, 'YouTube item.snippet.textMessageDetails');
    if (typeof item.id !== 'string' || item.id.length === 0 || typeof details.messageText !== 'string' ||
        typeof snippet.publishedAt !== 'string') {
      throw new DataCollectorError('UNEXPECTED', 'YouTube text message is incomplete');
    }
    const comment: NormalizedComment = {
      commentId: item.id,
      text: details.messageText,
      publishedAt: normalizeTimestamp(snippet.publishedAt, 'publishedAt'),
    };
    const previous = comments.get(comment.commentId);
    if (previous && (previous.text !== comment.text || previous.publishedAt !== comment.publishedAt)) {
      throw new DataCollectorError('COMMENT_ID_CONFLICT', 'The same comment ID has conflicting content');
    }
    comments.set(comment.commentId, comment);
  }
  return [...comments.values()].sort((left, right) =>
    Buffer.compare(Buffer.from(left.commentId, 'utf8'), Buffer.from(right.commentId, 'utf8')));
}

function verifySnapshotIdentity(snapshot: CommentPageSnapshot, input: CollectCommentsInput): void {
  if (snapshot.streamId !== input.streamId || snapshot.collectionJobId !== input.collectionJobId ||
      snapshot.youtubeLiveChatId !== input.youtubeLiveChatId ||
      snapshot.requestPageToken !== input.checkpoint.nextPageToken) {
    throw new DataCollectorError('OUTBOX_CONFLICT', 'Existing Snapshot request identity does not match');
  }
}

async function collect(input: CollectCommentsInput, dependencies: OperationDependencies): Promise<CollectCommentsOutput> {
  const id = pageId(input.streamId, input.collectionJobId, input.youtubeLiveChatId, input.checkpoint.nextPageToken);
  const snapshotObjectKey = `outbox/youtube/collection-jobs/${input.collectionJobId}/pages/${id}.json`;
  requireTimeBudget(dependencies);
  let snapshotBytes = await dependencies.store.get(snapshotObjectKey);
  let snapshot: CommentPageSnapshot;
  if (snapshotBytes !== null) {
    snapshot = parseSnapshot(snapshotBytes);
    verifySnapshotIdentity(snapshot, input);
  } else {
    const observationCandidate = normalizeTimestamp(dependencies.now().toISOString(), 'observationStartedAt');
    requireTimeBudget(dependencies);
    const page = await dependencies.youtube.getComments(input.youtubeLiveChatId, input.checkpoint.nextPageToken);
    const comments = normalizeComments(page.items);
    snapshot = {
      schemaVersion: 'comment-page-v1',
      streamId: input.streamId,
      collectionJobId: input.collectionJobId,
      youtubeLiveChatId: input.youtubeLiveChatId,
      requestPageToken: input.checkpoint.nextPageToken,
      responseNextPageToken: page.responseNextPageToken,
      observationStartedAt: input.checkpoint.observationStartedAt ?? observationCandidate,
      pollingIntervalMillis: page.pollingIntervalMillis,
      offlineAt: page.offlineAt,
      comments,
    };
    const proposedBytes = Buffer.from(canonicalJson(snapshot), 'utf8');
    requireTimeBudget(dependencies);
    const stored = await writeFirstWriterWins(dependencies.store, snapshotObjectKey, proposedBytes);
    snapshotBytes = stored.bytes;
    snapshot = parseSnapshot(snapshotBytes);
    verifySnapshotIdentity(snapshot, input);
  }

  const analysisStartAt = laterTimestamp(input.streamStartedAt, snapshot.observationStartedAt);
  const serialized = splitBatches(input.streamId, input.collectionJobId, analysisStartAt,
    input.youtubeVideoId, snapshot.comments, dependencies.maxMessageBodyBytes);
  const descriptors = [];
  for (const batch of serialized) {
    const key = `outbox/youtube/collection-jobs/${input.collectionJobId}/batches/${batch.payload.batchId}.json`;
    const bytes = Buffer.from(batch.body, 'utf8');
    requireTimeBudget(dependencies);
    await writeImmutable(dependencies.store, key, bytes, batch.payloadSha256);
    descriptors.push({ batchId: batch.payload.batchId, outboxObjectKey: key, payloadSha256: batch.payloadSha256 });
  }
  const collectedCommentCount = (BigInt(input.checkpoint.collectedCommentCount) + BigInt(snapshot.comments.length)).toString();
  return { pendingPage: {
    requestPageToken: snapshot.requestPageToken,
    responseNextPageToken: snapshot.responseNextPageToken,
    snapshotObjectKey,
    snapshotSha256: sha256(snapshotBytes),
    observationStartedAt: snapshot.observationStartedAt,
    pollingIntervalMillis: snapshot.pollingIntervalMillis,
    offlineAt: snapshot.offlineAt,
    collectedCommentCount,
    batches: descriptors,
  } };
}

function verifyBatch(bytes: Uint8Array, input: SendRegisteredBatchesInput, batchId: string): string {
  const value = record(utf8Json(bytes, 'Batch Outbox'), 'Batch Outbox');
  exactKeys(value, ['schemaVersion', 'batchId', 'streamId', 'collectionJobId', 'analysisStartAt',
    'youtubeVideoId', 'comments'], 'Batch Outbox');
  if (value.schemaVersion !== 'comment-batch-v1' || value.batchId !== batchId || value.streamId !== input.streamId ||
      value.collectionJobId !== input.collectionJobId || !Array.isArray(value.comments)) {
    throw new DataCollectorError('OUTBOX_INTEGRITY', 'Batch Outbox identity does not match');
  }
  const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (sqsJson(value as unknown as CommentBatchPayload) !== body) {
    throw new DataCollectorError('OUTBOX_INTEGRITY', 'Batch Outbox is not sqs-json-v1 canonical bytes');
  }
  return body;
}

async function send(input: SendRegisteredBatchesInput, dependencies: OperationDependencies): Promise<SendRegisteredBatchesOutput> {
  requireTimeBudget(dependencies);
  const snapshotBytes = await getRequired(dependencies.store, input.pendingPage.snapshotObjectKey);
  if (sha256(snapshotBytes) !== input.pendingPage.snapshotSha256) {
    throw new DataCollectorError('OUTBOX_INTEGRITY', 'Snapshot SHA-256 does not match');
  }
  const snapshot = parseSnapshot(snapshotBytes);
  if (snapshot.streamId !== input.streamId || snapshot.collectionJobId !== input.collectionJobId ||
      snapshot.requestPageToken !== input.pendingPage.requestPageToken ||
      snapshot.responseNextPageToken !== input.pendingPage.responseNextPageToken ||
      snapshot.observationStartedAt !== input.pendingPage.observationStartedAt ||
      snapshot.pollingIntervalMillis !== input.pendingPage.pollingIntervalMillis ||
      snapshot.offlineAt !== input.pendingPage.offlineAt) {
    throw new DataCollectorError('OUTBOX_INTEGRITY', 'Snapshot does not match pendingPage');
  }
  for (const descriptor of input.pendingPage.batches) {
    requireTimeBudget(dependencies);
    const bytes = await getRequired(dependencies.store, descriptor.outboxObjectKey);
    if (sha256(bytes) !== descriptor.payloadSha256) {
      throw new DataCollectorError('OUTBOX_INTEGRITY', 'Batch Payload SHA-256 does not match');
    }
    const body = verifyBatch(bytes, input, descriptor.batchId);
    if (Buffer.byteLength(body, 'utf8') > dependencies.maxMessageBodyBytes) {
      throw new DataCollectorError('OUTBOX_INTEGRITY', 'Batch Payload exceeds the configured size limit');
    }
    requireTimeBudget(dependencies);
    await dependencies.queue.send(body);
  }
  return {
    sentBatchCount: input.pendingPage.batches.length,
    offlineAt: input.pendingPage.offlineAt,
    checkpoint: {
      nextPageToken: input.pendingPage.responseNextPageToken,
      observationStartedAt: input.pendingPage.observationStartedAt,
      pollingIntervalMillis: input.pendingPage.pollingIntervalMillis,
      collectedCommentCount: input.pendingPage.collectedCommentCount,
    },
  };
}

export async function executeOperation(
  input: DataCollectorInput,
  dependencies: OperationDependencies,
): Promise<DataCollectorOutput> {
  switch (input.operation) {
    case 'GET_STREAM_METADATA': {
      requireTimeBudget(dependencies);
      const video = await dependencies.youtube.getVideo(input.youtubeVideoId);
      const output: GetStreamMetadataOutput = video;
      return output;
    }
    case 'GET_FINAL_STREAM_METADATA': {
      requireTimeBudget(dependencies);
      const video = await dependencies.youtube.getVideo(input.youtubeVideoId);
      if (video.startedAt === null) throw new DataCollectorError('UNEXPECTED', 'Final stream metadata has no actual start time');
      const output: GetFinalStreamMetadataOutput = {
        youtubeVideoId: video.youtubeVideoId, title: video.title, startedAt: video.startedAt,
        endedAt: video.endedAt, streamStatus: video.streamStatus,
      };
      return output;
    }
    case 'COLLECT_COMMENTS': return collect(input, dependencies);
    case 'SEND_REGISTERED_BATCHES': return send(input, dependencies);
  }
}
