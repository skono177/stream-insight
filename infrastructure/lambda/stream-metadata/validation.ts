import {
  BatchDescriptor,
  MarkAnalysisFailedInput,
  RegisterBatchesInput,
  StartCollectionInput,
  StopCollectionInput,
  StreamMetadataInput,
} from './contracts';
import { validationError } from './errors';
import { timestampInstant } from './timestamps';

const INTERNAL_ID = /^[1-9][0-9]*$/;
const NON_NEGATIVE_BIGINT = /^(0|[1-9][0-9]*)$/;
const SAFE_EXTERNAL_ID = /^[A-Za-z0-9_-]+$/;
const BATCH_ID = /^batch-v1-[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw validationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = Object.keys(value);
  const unknown = keys.find((key) => !allowed.includes(key));
  if (unknown) throw validationError(`${label} contains unknown field: ${unknown}`);
  const missing = allowed.find((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing) throw validationError(`${label} is missing required field: ${missing}`);
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw validationError(`${label} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : string(value, label);
}

function internalId(value: unknown, label: string): string {
  const result = string(value, label);
  if (!INTERNAL_ID.test(result)) throw validationError(`${label} must be a positive decimal string`);
  return result;
}

function count(value: unknown, label: string): string {
  const result = string(value, label);
  if (!NON_NEGATIVE_BIGINT.test(result)) throw validationError(`${label} must be a non-negative decimal string`);
  return result;
}

function externalId(value: unknown, label: string): string {
  const result = string(value, label);
  if (!SAFE_EXTERNAL_ID.test(result)) throw validationError(`${label} has an invalid format`);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = string(value, label);
  const match = UTC_TIMESTAMP.exec(result);
  if (!match) throw validationError(`${label} must be a UTC RFC 3339 timestamp`);
  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(result);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day) ||
    parsed.getUTCHours() !== Number(hour) ||
    parsed.getUTCMinutes() !== Number(minute) ||
    parsed.getUTCSeconds() !== Number(second)
  ) {
    throw validationError(`${label} must be a valid UTC RFC 3339 timestamp`);
  }
  return result;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const result = string(value, label);
  if (!allowed.includes(result as T)) throw validationError(`${label} has an invalid value`);
  return result as T;
}

function batch(value: unknown, index: number): BatchDescriptor {
  const item = object(value, `batches[${index}]`);
  exactKeys(item, ['batchId', 'outboxObjectKey', 'payloadSha256'], `batches[${index}]`);
  const batchId = string(item.batchId, `batches[${index}].batchId`);
  const payloadSha256 = string(item.payloadSha256, `batches[${index}].payloadSha256`);
  if (!BATCH_ID.test(batchId)) throw validationError(`batches[${index}].batchId has an invalid format`);
  if (!SHA256.test(payloadSha256)) throw validationError(`batches[${index}].payloadSha256 has an invalid format`);
  return {
    batchId,
    outboxObjectKey: string(item.outboxObjectKey, `batches[${index}].outboxObjectKey`),
    payloadSha256,
  };
}

function start(input: Record<string, unknown>): StartCollectionInput {
  exactKeys(input, ['operation', 'executionArn', 'collectionStartedAt', 'stream'], 'input');
  const stream = object(input.stream, 'stream');
  exactKeys(stream, ['youtubeChannelId', 'channelName', 'youtubeVideoId', 'youtubeLiveChatId', 'title', 'startedAt'], 'stream');
  return {
    operation: 'START_COLLECTION',
    executionArn: string(input.executionArn, 'executionArn'),
    collectionStartedAt: timestamp(input.collectionStartedAt, 'collectionStartedAt'),
    stream: {
      youtubeChannelId: externalId(stream.youtubeChannelId, 'stream.youtubeChannelId'),
      channelName: string(stream.channelName, 'stream.channelName'),
      youtubeVideoId: externalId(stream.youtubeVideoId, 'stream.youtubeVideoId'),
      youtubeLiveChatId: externalId(stream.youtubeLiveChatId, 'stream.youtubeLiveChatId'),
      title: string(stream.title, 'stream.title'),
      startedAt: timestamp(stream.startedAt, 'stream.startedAt'),
    },
  };
}

function register(input: Record<string, unknown>): RegisterBatchesInput {
  exactKeys(input, ['operation', 'streamId', 'collectionJobId', 'executionArn', 'observationStartedAt', 'batches'], 'input');
  if (!Array.isArray(input.batches)) throw validationError('batches must be an array');
  const batches = input.batches.map(batch);
  const seen = new Set<string>();
  for (const descriptor of batches) {
    if (seen.has(descriptor.batchId)) throw validationError('batches contains duplicate batchId');
    seen.add(descriptor.batchId);
  }
  return {
    operation: 'REGISTER_BATCHES',
    streamId: internalId(input.streamId, 'streamId'),
    collectionJobId: internalId(input.collectionJobId, 'collectionJobId'),
    executionArn: string(input.executionArn, 'executionArn'),
    observationStartedAt: timestamp(input.observationStartedAt, 'observationStartedAt'),
    batches,
  };
}

function stop(input: Record<string, unknown>): StopCollectionInput {
  exactKeys(input, ['operation', 'streamId', 'collectionJobId', 'executionArn', 'youtubeVideoId', 'title', 'startedAt', 'endedAt', 'collectionStoppedAt', 'collectionStatus', 'lastPageToken', 'collectedCommentCount', 'stopReason', 'errorCode'], 'input');
  const collectionStatus = enumValue(input.collectionStatus, ['COMPLETED', 'FAILED'] as const, 'collectionStatus');
  const endedAt = input.endedAt === null ? null : timestamp(input.endedAt, 'endedAt');
  const errorCode = nullableString(input.errorCode, 'errorCode');
  if (collectionStatus === 'COMPLETED' && (endedAt === null || errorCode !== null)) {
    throw validationError('COMPLETED requires endedAt and null errorCode');
  }
  if (collectionStatus === 'FAILED' && errorCode === null) {
    throw validationError('FAILED requires errorCode');
  }
  const startedAt = timestamp(input.startedAt, 'startedAt');
  if (endedAt !== null && timestampInstant(endedAt)! < timestampInstant(startedAt)!) {
    throw validationError('endedAt must not precede startedAt');
  }
  return {
    operation: 'STOP_COLLECTION',
    streamId: internalId(input.streamId, 'streamId'),
    collectionJobId: internalId(input.collectionJobId, 'collectionJobId'),
    executionArn: string(input.executionArn, 'executionArn'),
    youtubeVideoId: externalId(input.youtubeVideoId, 'youtubeVideoId'),
    title: string(input.title, 'title'),
    startedAt,
    endedAt,
    collectionStoppedAt: timestamp(input.collectionStoppedAt, 'collectionStoppedAt'),
    collectionStatus,
    lastPageToken: nullableString(input.lastPageToken, 'lastPageToken'),
    collectedCommentCount: count(input.collectedCommentCount, 'collectedCommentCount'),
    stopReason: string(input.stopReason, 'stopReason'),
    errorCode,
  };
}

function mark(input: Record<string, unknown>): MarkAnalysisFailedInput {
  exactKeys(input, ['operation', 'streamId', 'collectionJobId', 'executionArn', 'errorCode'], 'input');
  return {
    operation: 'MARK_ANALYSIS_FAILED',
    streamId: internalId(input.streamId, 'streamId'),
    collectionJobId: internalId(input.collectionJobId, 'collectionJobId'),
    executionArn: string(input.executionArn, 'executionArn'),
    errorCode: string(input.errorCode, 'errorCode'),
  };
}

export function validateInput(value: unknown): StreamMetadataInput {
  const input = object(value, 'input');
  const operation = string(input.operation, 'operation');
  switch (operation) {
    case 'START_COLLECTION': return start(input);
    case 'REGISTER_BATCHES': return register(input);
    case 'STOP_COLLECTION': return stop(input);
    case 'MARK_ANALYSIS_FAILED': return mark(input);
    default: throw validationError('operation is not supported');
  }
}
