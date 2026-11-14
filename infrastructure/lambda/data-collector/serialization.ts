import { createHash } from 'node:crypto';
import { CommentBatchPayload, NormalizedComment } from './contracts';
import { DataCollectorError, validationError } from './errors';

export const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

export function assertUnicodeScalars(value: unknown, label = 'value'): void {
  if (typeof value === 'string') {
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw validationError(`${label} contains an unpaired surrogate`);
        i += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        throw validationError(`${label} contains an unpaired surrogate`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertUnicodeScalars(item, `${label}[${index}]`));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) assertUnicodeScalars(item, `${label}.${key}`);
  }
}

export function canonicalJson(value: unknown): string {
  assertUnicodeScalars(value);
  const result = JSON.stringify(value);
  if (result === undefined) throw validationError('canonical JSON value is not serializable');
  return result;
}

export function sqsJson(value: unknown): string {
  return canonicalJson(value).replace(/\ufffe/g, '\\ufffe').replace(/\uffff/g, '\\uffff');
}

export function batchId(streamId: string, youtubeVideoId: string, comments: readonly NormalizedComment[]): string {
  const tuples = comments.map((comment) => [comment.commentId, comment.text, comment.publishedAt]);
  return `batch-v1-${sha256(canonicalJson(['batch-v1', streamId, youtubeVideoId, tuples]))}`;
}

export function pageId(
  streamId: string,
  collectionJobId: string,
  youtubeLiveChatId: string,
  requestPageToken: string | null,
): string {
  return `page-v1-${sha256(canonicalJson([
    'page-v1', streamId, collectionJobId, youtubeLiveChatId, requestPageToken ?? '',
  ]))}`;
}

export interface SerializedBatch {
  readonly payload: CommentBatchPayload;
  readonly body: string;
  readonly payloadSha256: string;
}

export function serializeBatch(
  streamId: string,
  collectionJobId: string,
  analysisStartAt: string,
  youtubeVideoId: string,
  comments: readonly NormalizedComment[],
): SerializedBatch {
  const id = batchId(streamId, youtubeVideoId, comments);
  const payload: CommentBatchPayload = {
    schemaVersion: 'comment-batch-v1',
    batchId: id,
    streamId,
    collectionJobId,
    analysisStartAt,
    youtubeVideoId,
    comments,
  };
  const body = sqsJson(payload);
  return { payload, body, payloadSha256: sha256(body) };
}

export function splitBatches(
  streamId: string,
  collectionJobId: string,
  analysisStartAt: string,
  youtubeVideoId: string,
  comments: readonly NormalizedComment[],
  maxBytes: number,
): readonly SerializedBatch[] {
  const result: SerializedBatch[] = [];
  let current: NormalizedComment[] = [];
  for (const comment of comments) {
    const candidate = [...current, comment];
    const serialized = serializeBatch(streamId, collectionJobId, analysisStartAt, youtubeVideoId, candidate);
    if (Buffer.byteLength(serialized.body, 'utf8') <= maxBytes) {
      current = candidate;
      continue;
    }
    if (current.length === 0) throw new DataCollectorError('MESSAGE_TOO_LARGE', 'A single comment exceeds the message size limit');
    result.push(serializeBatch(streamId, collectionJobId, analysisStartAt, youtubeVideoId, current));
    current = [comment];
    const single = serializeBatch(streamId, collectionJobId, analysisStartAt, youtubeVideoId, current);
    if (Buffer.byteLength(single.body, 'utf8') > maxBytes) {
      throw new DataCollectorError('MESSAGE_TOO_LARGE', 'A single comment exceeds the message size limit');
    }
  }
  if (current.length > 0) result.push(serializeBatch(streamId, collectionJobId, analysisStartAt, youtubeVideoId, current));
  return result;
}
