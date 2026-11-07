import assert from 'node:assert/strict';
import test from 'node:test';
import { DataCollectorError } from '../lambda/data-collector/errors';
import { validateInput } from '../lambda/data-collector/validation';

const sha = 'a'.repeat(64);
const page = `page-v1-${'b'.repeat(64)}`;

test('validates all four operation contracts and preserves decimal strings', () => {
  assert.equal(validateInput({ operation: 'GET_STREAM_METADATA', youtubeVideoId: 'video-1' }).operation, 'GET_STREAM_METADATA');
  assert.equal(validateInput({ operation: 'GET_FINAL_STREAM_METADATA', youtubeVideoId: 'video-1' }).operation, 'GET_FINAL_STREAM_METADATA');
  const collect = validateInput({
    operation: 'COLLECT_COMMENTS', streamId: '9007199254740993', collectionJobId: '2', youtubeVideoId: 'video-1',
    youtubeLiveChatId: 'chat_1', streamStartedAt: '2026-01-01T00:00:00Z',
    checkpoint: { nextPageToken: null, observationStartedAt: null, pollingIntervalMillis: null, collectedCommentCount: '0' },
  });
  assert.equal(collect.operation, 'COLLECT_COMMENTS');
  assert.equal(collect.streamId, '9007199254740993');
  const send = validateInput({
    operation: 'SEND_REGISTERED_BATCHES', streamId: '1', collectionJobId: '2', registeredBatchCount: 1,
    pendingPage: { requestPageToken: null, responseNextPageToken: 'next',
      snapshotObjectKey: `outbox/youtube/collection-jobs/2/pages/${page}.json`, snapshotSha256: sha,
      observationStartedAt: '2026-01-01T00:00:00Z', pollingIntervalMillis: 5000, offlineAt: null,
      collectedCommentCount: '1', batches: [{ batchId: `batch-v1-${sha}`,
        outboxObjectKey: `outbox/youtube/collection-jobs/2/batches/batch-v1-${sha}.json`, payloadSha256: sha }] },
  });
  assert.equal(send.operation, 'SEND_REGISTERED_BATCHES');
});

test('rejects unknown fields, inconsistent checkpoint, count mismatch and key substitution', () => {
  const invalid: unknown[] = [
    { operation: 'GET_STREAM_METADATA', youtubeVideoId: 'video', extra: true },
    { operation: 'COLLECT_COMMENTS', streamId: '01', collectionJobId: '2', youtubeVideoId: 'video',
      youtubeLiveChatId: 'chat', streamStartedAt: '2026-01-01T00:00:00Z',
      checkpoint: { nextPageToken: null, observationStartedAt: '2026-01-01T00:00:00Z', pollingIntervalMillis: null, collectedCommentCount: '0' } },
    { operation: 'SEND_REGISTERED_BATCHES', streamId: '1', collectionJobId: '2', registeredBatchCount: 1,
      pendingPage: { requestPageToken: null, responseNextPageToken: 'next',
        snapshotObjectKey: `outbox/youtube/collection-jobs/2/pages/${page}.json`, snapshotSha256: sha,
        observationStartedAt: '2026-01-01T00:00:00Z', pollingIntervalMillis: 1, offlineAt: null,
        collectedCommentCount: '0', batches: [] } },
    { operation: 'SEND_REGISTERED_BATCHES', streamId: '1', collectionJobId: '2', registeredBatchCount: 1,
      pendingPage: { requestPageToken: null, responseNextPageToken: 'next',
        snapshotObjectKey: `outbox/youtube/collection-jobs/2/pages/${page}.json`, snapshotSha256: sha,
        observationStartedAt: '2026-01-01T00:00:00Z', pollingIntervalMillis: 1, offlineAt: null,
        collectedCommentCount: '1', batches: [{ batchId: `batch-v1-${sha}`,
          outboxObjectKey: `outbox/youtube/collection-jobs/999/batches/batch-v1-${sha}.json`, payloadSha256: sha }] } },
  ];
  for (const value of invalid) assert.throws(() => validateInput(value), (error: unknown) =>
    error instanceof DataCollectorError && error.classification === 'VALIDATION');
});
