import {
  BatchDescriptor,
  Checkpoint,
  CollectCommentsInput,
  DataCollectorInput,
  GetFinalStreamMetadataInput,
  GetStreamMetadataInput,
  PendingPage,
  SendRegisteredBatchesInput,
} from './contracts';
import { validationError } from './errors';
import { normalizeTimestamp } from './timestamps';

const INTERNAL_ID = /^[1-9][0-9]*$/;
const NON_NEGATIVE_BIGINT = /^(0|[1-9][0-9]*)$/;
const SAFE_EXTERNAL_ID = /^[A-Za-z0-9_-]+$/;
const BATCH_ID = /^batch-v1-[0-9a-f]{64}$/;
const PAGE_ID = /^page-v1-[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw validationError(`${label} must be an object`);
  return value as Record<string, unknown>;
};

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw validationError(`${label} contains unknown field: ${unknown}`);
  const missing = allowed.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing) throw validationError(`${label} is missing required field: ${missing}`);
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw validationError(`${label} must be a non-empty string`);
  return value;
}

const nullableString = (value: unknown, label: string): string | null => value === null ? null : string(value, label);

function internalId(value: unknown, label: string): string {
  const result = string(value, label);
  if (!INTERNAL_ID.test(result)) throw validationError(`${label} must be a positive decimal string`);
  return result;
}

function externalId(value: unknown, label: string): string {
  const result = string(value, label);
  if (!SAFE_EXTERNAL_ID.test(result)) throw validationError(`${label} has an invalid format`);
  return result;
}

function count(value: unknown, label: string): string {
  const result = string(value, label);
  if (!NON_NEGATIVE_BIGINT.test(result)) throw validationError(`${label} must be a non-negative decimal string`);
  return result;
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw validationError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function nullableSafeInteger(value: unknown, label: string): number | null {
  return value === null ? null : safeInteger(value, label);
}

function checkpoint(value: unknown): Checkpoint {
  const item = object(value, 'checkpoint');
  exactKeys(item, ['nextPageToken', 'observationStartedAt', 'pollingIntervalMillis', 'collectedCommentCount'], 'checkpoint');
  const result: Checkpoint = {
    nextPageToken: nullableString(item.nextPageToken, 'checkpoint.nextPageToken'),
    observationStartedAt: item.observationStartedAt === null
      ? null : normalizeTimestamp(string(item.observationStartedAt, 'checkpoint.observationStartedAt'), 'checkpoint.observationStartedAt'),
    pollingIntervalMillis: nullableSafeInteger(item.pollingIntervalMillis, 'checkpoint.pollingIntervalMillis'),
    collectedCommentCount: count(item.collectedCommentCount, 'checkpoint.collectedCommentCount'),
  };
  const initial = result.nextPageToken === null && result.observationStartedAt === null && result.pollingIntervalMillis === null;
  const continued = result.nextPageToken !== null && result.observationStartedAt !== null && result.pollingIntervalMillis !== null;
  if (!initial && !continued) throw validationError('checkpoint fields are inconsistent');
  return result;
}

function descriptor(value: unknown, index: number, collectionJobId: string): BatchDescriptor {
  const item = object(value, `pendingPage.batches[${index}]`);
  exactKeys(item, ['batchId', 'outboxObjectKey', 'payloadSha256'], `pendingPage.batches[${index}]`);
  const id = string(item.batchId, `pendingPage.batches[${index}].batchId`);
  const hash = string(item.payloadSha256, `pendingPage.batches[${index}].payloadSha256`);
  if (!BATCH_ID.test(id)) throw validationError(`pendingPage.batches[${index}].batchId has an invalid format`);
  if (!SHA256.test(hash)) throw validationError(`pendingPage.batches[${index}].payloadSha256 has an invalid format`);
  const key = string(item.outboxObjectKey, `pendingPage.batches[${index}].outboxObjectKey`);
  if (key !== `outbox/youtube/collection-jobs/${collectionJobId}/batches/${id}.json`) {
    throw validationError(`pendingPage.batches[${index}].outboxObjectKey is inconsistent`);
  }
  return { batchId: id, outboxObjectKey: key, payloadSha256: hash };
}

function pendingPage(value: unknown, collectionJobId: string): PendingPage {
  const item = object(value, 'pendingPage');
  exactKeys(item, ['requestPageToken', 'responseNextPageToken', 'snapshotObjectKey', 'snapshotSha256',
    'observationStartedAt', 'pollingIntervalMillis', 'offlineAt', 'collectedCommentCount', 'batches'], 'pendingPage');
  if (!Array.isArray(item.batches)) throw validationError('pendingPage.batches must be an array');
  const batches = item.batches.map((batch, index) => descriptor(batch, index, collectionJobId));
  if (new Set(batches.map((batch) => batch.batchId)).size !== batches.length) {
    throw validationError('pendingPage.batches contains duplicate batchId');
  }
  const snapshotObjectKey = string(item.snapshotObjectKey, 'pendingPage.snapshotObjectKey');
  const expectedPrefix = `outbox/youtube/collection-jobs/${collectionJobId}/pages/`;
  const pageName = snapshotObjectKey.slice(expectedPrefix.length, -'.json'.length);
  if (!snapshotObjectKey.startsWith(expectedPrefix) || !snapshotObjectKey.endsWith('.json') || !PAGE_ID.test(pageName)) {
    throw validationError('pendingPage.snapshotObjectKey has an invalid format');
  }
  const snapshotSha256 = string(item.snapshotSha256, 'pendingPage.snapshotSha256');
  if (!SHA256.test(snapshotSha256)) throw validationError('pendingPage.snapshotSha256 has an invalid format');
  return {
    requestPageToken: nullableString(item.requestPageToken, 'pendingPage.requestPageToken'),
    responseNextPageToken: string(item.responseNextPageToken, 'pendingPage.responseNextPageToken'),
    snapshotObjectKey,
    snapshotSha256,
    observationStartedAt: normalizeTimestamp(string(item.observationStartedAt, 'pendingPage.observationStartedAt')),
    pollingIntervalMillis: safeInteger(item.pollingIntervalMillis, 'pendingPage.pollingIntervalMillis'),
    offlineAt: item.offlineAt === null ? null : normalizeTimestamp(string(item.offlineAt, 'pendingPage.offlineAt')),
    collectedCommentCount: count(item.collectedCommentCount, 'pendingPage.collectedCommentCount'),
    batches,
  };
}

function getMetadata(input: Record<string, unknown>): GetStreamMetadataInput | GetFinalStreamMetadataInput {
  exactKeys(input, ['operation', 'youtubeVideoId'], 'input');
  const operation = string(input.operation, 'operation');
  const youtubeVideoId = externalId(input.youtubeVideoId, 'youtubeVideoId');
  if (operation === 'GET_STREAM_METADATA') return { operation, youtubeVideoId };
  if (operation === 'GET_FINAL_STREAM_METADATA') return { operation, youtubeVideoId };
  throw validationError('operation is not supported');
}

function collect(input: Record<string, unknown>): CollectCommentsInput {
  exactKeys(input, ['operation', 'streamId', 'collectionJobId', 'youtubeVideoId', 'youtubeLiveChatId',
    'streamStartedAt', 'checkpoint'], 'input');
  return {
    operation: 'COLLECT_COMMENTS',
    streamId: internalId(input.streamId, 'streamId'),
    collectionJobId: internalId(input.collectionJobId, 'collectionJobId'),
    youtubeVideoId: externalId(input.youtubeVideoId, 'youtubeVideoId'),
    youtubeLiveChatId: externalId(input.youtubeLiveChatId, 'youtubeLiveChatId'),
    streamStartedAt: normalizeTimestamp(string(input.streamStartedAt, 'streamStartedAt'), 'streamStartedAt'),
    checkpoint: checkpoint(input.checkpoint),
  };
}

function send(input: Record<string, unknown>): SendRegisteredBatchesInput {
  exactKeys(input, ['operation', 'streamId', 'collectionJobId', 'registeredBatchCount', 'pendingPage'], 'input');
  const collectionJobId = internalId(input.collectionJobId, 'collectionJobId');
  const page = pendingPage(input.pendingPage, collectionJobId);
  const registeredBatchCount = safeInteger(input.registeredBatchCount, 'registeredBatchCount');
  if (registeredBatchCount !== page.batches.length) {
    throw validationError('registeredBatchCount must match pendingPage.batches.length');
  }
  return {
    operation: 'SEND_REGISTERED_BATCHES',
    streamId: internalId(input.streamId, 'streamId'),
    collectionJobId,
    registeredBatchCount,
    pendingPage: page,
  };
}

export function validateInput(value: unknown): DataCollectorInput {
  const input = object(value, 'input');
  const operation = string(input.operation, 'operation');
  switch (operation) {
    case 'GET_STREAM_METADATA':
    case 'GET_FINAL_STREAM_METADATA': return getMetadata(input);
    case 'COLLECT_COMMENTS': return collect(input);
    case 'SEND_REGISTERED_BATCHES': return send(input);
    default: throw validationError('operation is not supported');
  }
}
