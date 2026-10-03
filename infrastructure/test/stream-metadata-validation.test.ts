import assert from 'node:assert/strict';
import test from 'node:test';
import { StreamMetadataError } from '../lambda/stream-metadata/errors';
import { sameTimestamp, timestampInstant } from '../lambda/stream-metadata/timestamps';
import { validateInput } from '../lambda/stream-metadata/validation';

const sha = 'a'.repeat(64);

test('validates all operation contracts and preserves BIGINT strings', () => {
  const register = validateInput({
    operation: 'REGISTER_BATCHES', streamId: '9007199254740993', collectionJobId: '2', executionArn: 'arn',
    observationStartedAt: '2026-08-23T15:00:00Z',
    batches: [{ batchId: `batch-v1-${sha}`, outboxObjectKey: 'key', payloadSha256: sha }],
  });
  assert.equal(register.operation, 'REGISTER_BATCHES');
  assert.equal(register.streamId, '9007199254740993');

  assert.equal(validateInput({
    operation: 'START_COLLECTION', executionArn: 'arn', collectionStartedAt: '2026-08-23T15:00:00Z',
    stream: { youtubeChannelId: 'channel_1', channelName: 'name', youtubeVideoId: 'video-1',
      youtubeLiveChatId: 'chat_1', title: 'title', startedAt: '2026-08-23T14:58:00Z' },
  }).operation, 'START_COLLECTION');
  assert.equal(validateInput({
    operation: 'MARK_ANALYSIS_FAILED', streamId: '1', collectionJobId: '2', executionArn: 'arn', errorCode: 'TIMEOUT',
  }).operation, 'MARK_ANALYSIS_FAILED');
});

test('rejects unknown fields, invalid timestamps, duplicate batches and unsafe IDs before DB access', () => {
  const invalid: unknown[] = [
    { operation: 'UNKNOWN' },
    { operation: 'MARK_ANALYSIS_FAILED', streamId: '1', collectionJobId: '2', executionArn: 'arn' },
    { operation: 'MARK_ANALYSIS_FAILED', streamId: '1', collectionJobId: '2', executionArn: 'arn', errorCode: 'x', extra: true },
    { operation: 'MARK_ANALYSIS_FAILED', streamId: '01', collectionJobId: '2', executionArn: 'arn', errorCode: 'x' },
    { operation: 'START_COLLECTION', executionArn: 'arn', collectionStartedAt: '2026-02-30T00:00:00Z', stream: {} },
    { operation: 'REGISTER_BATCHES', streamId: '1', collectionJobId: '2', executionArn: 'arn',
      observationStartedAt: '2026-08-23T15:00:00Z', batches: [
        { batchId: `batch-v1-${sha}`, outboxObjectKey: 'a', payloadSha256: sha },
        { batchId: `batch-v1-${sha}`, outboxObjectKey: 'b', payloadSha256: sha },
      ] },
    { operation: 'REGISTER_BATCHES', streamId: '1', collectionJobId: '2', executionArn: 'arn',
      observationStartedAt: '2026-08-23T15:00:00Z',
      batches: [{ batchId: `batch-v1-${sha}`, outboxObjectKey: 'a', payloadSha256: 'NOT_SHA256' }] },
  ];
  for (const value of invalid) {
    assert.throws(() => validateInput(value), (error: unknown) => error instanceof StreamMetadataError && error.classification === 'VALIDATION');
  }
});

test('enforces STOP_COLLECTION conditional fields and time range', () => {
  const base = {
    operation: 'STOP_COLLECTION', streamId: '1', collectionJobId: '2', executionArn: 'arn', youtubeVideoId: 'video',
    title: 'title', startedAt: '2026-08-23T15:00:00Z', endedAt: null, collectionStoppedAt: '2026-08-23T16:00:00Z',
    collectionStatus: 'COMPLETED', lastPageToken: null, collectedCommentCount: '0', stopReason: 'END', errorCode: null,
  };
  assert.throws(() => validateInput(base), StreamMetadataError);
  assert.throws(() => validateInput({ ...base, collectionStatus: 'FAILED', errorCode: 'FAIL', endedAt: '2026-08-23T14:00:00Z' }), StreamMetadataError);
  assert.equal(validateInput({ ...base, endedAt: '2026-08-23T16:00:00Z' }).operation, 'STOP_COLLECTION');
});

test('compares STOP_COLLECTION timestamps without losing sub-millisecond precision', () => {
  const base = {
    operation: 'STOP_COLLECTION', streamId: '1', collectionJobId: '2', executionArn: 'arn', youtubeVideoId: 'video',
    title: 'title', startedAt: '2026-01-01T00:00:00.000001Z', endedAt: '2026-01-01T00:00:00.000002Z',
    collectionStoppedAt: '2026-01-01T00:01:00Z', collectionStatus: 'COMPLETED', lastPageToken: null,
    collectedCommentCount: '0', stopReason: 'END', errorCode: null,
  };
  assert.equal(validateInput(base).operation, 'STOP_COLLECTION');
  assert.equal(validateInput({ ...base, endedAt: base.startedAt }).operation, 'STOP_COLLECTION');
  assert.throws(() => validateInput({
    ...base,
    startedAt: '2026-01-01T00:00:00.000002Z',
    endedAt: '2026-01-01T00:00:00.000001Z',
  }), (error: unknown) => error instanceof StreamMetadataError && error.classification === 'VALIDATION');
  assert.equal(sameTimestamp('2026-01-01T00:00:00.000001Z', '2025-12-31T19:00:00.000001-05:00'), true);
});

test('rounds fractional seconds to PostgreSQL microseconds using ties-to-even', () => {
  const base = timestampInstant('2026-01-01T00:00:00Z')!;
  for (const [fraction, micros] of [
    ['0000014', 1n],
    ['0000015', 2n],
    ['0000016', 2n],
    ['0000025', 2n],
    ['0000035', 4n],
    ['0000045', 4n],
    ['9999985', 999_998n],
  ] as const) {
    assert.equal(timestampInstant(`2026-01-01T00:00:00.${fraction}Z`), base + micros, fraction);
  }
});

test('carries rounded microseconds across second, day, month and year boundaries', () => {
  assert.equal(sameTimestamp('2026-01-01T00:00:00.9999995Z', '2026-01-01T00:00:01Z'), true);
  assert.equal(sameTimestamp('2026-01-31T23:59:59.9999995Z', '2026-02-01T00:00:00Z'), true);
  assert.equal(sameTimestamp('2026-12-31T23:59:59.9999995Z', '2027-01-01T00:00:00Z'), true);
});

test('normalizes timezone offsets and PostgreSQL six-digit stored representations', () => {
  const instant = '2026-01-01T00:00:00.000002Z';
  assert.equal(sameTimestamp(instant, '2026-01-01T00:00:00.000002+00:00'), true);
  assert.equal(sameTimestamp(instant, '2026-01-01T09:00:00.000002+09:00'), true);
  assert.equal(sameTimestamp(instant, '2025-12-31T19:00:00.000002-05:00'), true);
  assert.equal(sameTimestamp('2026-01-01T00:00:00.0000025Z', instant), true);
});

test('STOP_COLLECTION ordering uses PostgreSQL ties-to-even normalization', () => {
  const base = {
    operation: 'STOP_COLLECTION', streamId: '1', collectionJobId: '2', executionArn: 'arn', youtubeVideoId: 'video',
    title: 'title', startedAt: '2026-01-01T00:00:00.0000025Z', endedAt: '2026-01-01T00:00:00.0000024Z',
    collectionStoppedAt: '2026-01-01T00:01:00Z', collectionStatus: 'COMPLETED', lastPageToken: null,
    collectedCommentCount: '0', stopReason: 'END', errorCode: null,
  };
  assert.equal(validateInput(base).operation, 'STOP_COLLECTION');
  assert.throws(() => validateInput({
    ...base,
    startedAt: '2026-01-01T00:00:00.0000026Z',
    endedAt: '2026-01-01T00:00:00.0000025Z',
  }), (error: unknown) => error instanceof StreamMetadataError && error.classification === 'VALIDATION');
});
