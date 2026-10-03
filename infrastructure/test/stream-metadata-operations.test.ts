import assert from 'node:assert/strict';
import test from 'node:test';
import { StreamMetadataError } from '../lambda/stream-metadata/errors';
import { executeOperation, QueryResult, SqlExecutor } from '../lambda/stream-metadata/operations';

class ScriptedDatabase implements SqlExecutor {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = [];
  constructor(private readonly results: Array<QueryResult<unknown>>) {}
  async query<T>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>> {
    this.calls.push({ text, values });
    const result = this.results.shift();
    if (!result) throw new Error(`Unexpected query: ${text}`);
    return result as QueryResult<T>;
  }
}

const result = <T>(rows: T[], rowCount = rows.length): QueryResult<T> => ({ rows, rowCount });
const job = (changes: Record<string, unknown> = {}) => ({
  id: '2', stream_id: '1', execution_arn: 'arn', collection_started_at: '2026-08-23T15:00:00Z',
  observation_started_at: '2026-08-23T15:01:00Z', collection_stopped_at: null,
  collection_status: 'RUNNING', analysis_status: 'PENDING', last_page_token: null,
  collected_comment_count: '0', stop_reason: null, error_code: null, ...changes,
});
const stream = (changes: Record<string, unknown> = {}) => ({
  id: '1', channel_id: '10', youtube_video_id: 'video', youtube_live_chat_id: 'chat', title: 'title',
  started_at: '2026-08-23T15:00:00Z', ended_at: null, url: 'https://www.youtube.com/watch?v=video', ...changes,
});

test('START_COLLECTION exact retry performs no Channel or Stream UPDATE', async () => {
  const db = new ScriptedDatabase([
    result([], 0), result([{ id: '10', name: 'channel', url: 'https://www.youtube.com/channel/channel' }]),
    result([], 0), result([stream()]), result([], 0), result([job()]),
  ]);
  const output = await executeOperation(db, {
    operation: 'START_COLLECTION', executionArn: 'arn', collectionStartedAt: '2026-08-23T15:00:00Z',
    stream: { youtubeChannelId: 'channel', channelName: 'channel', youtubeVideoId: 'video',
      youtubeLiveChatId: 'chat', title: 'title', startedAt: '2026-08-23T15:00:00Z' },
  });
  assert.deepEqual(output, { streamId: '1', collectionJobId: '2' });
  assert.equal(db.calls.some((call) => /^UPDATE (channels|streams)/.test(call.text.trim())), false);
});

test('START_COLLECTION exact retry matches PostgreSQL stored microseconds after ties-to-even rounding', async () => {
  const db = new ScriptedDatabase([
    result([], 0), result([{ id: '10', name: 'channel', url: 'https://www.youtube.com/channel/channel' }]),
    result([], 0), result([stream({ started_at: '2026-01-01 00:00:00.000002+00' })]),
    result([], 0), result([job({ collection_started_at: '2026-01-01 00:00:00.000002+00' })]),
  ]);
  const output = await executeOperation(db, {
    operation: 'START_COLLECTION', executionArn: 'arn', collectionStartedAt: '2026-01-01T00:00:00.0000025Z',
    stream: { youtubeChannelId: 'channel', channelName: 'channel', youtubeVideoId: 'video',
      youtubeLiveChatId: 'chat', title: 'title', startedAt: '2026-01-01T00:00:00.0000025Z' },
  });
  assert.deepEqual(output, { streamId: '1', collectionJobId: '2' });
  assert.equal(db.calls.some((call) => /^UPDATE (channels|streams)/.test(call.text.trim())), false);
});

test('START_COLLECTION creates all three rows for a new stream', async () => {
  const db = new ScriptedDatabase([
    result([{ id: '10', name: 'channel', url: 'https://www.youtube.com/channel/channel' }]),
    result([stream()]), result([job()]),
  ]);
  assert.deepEqual(await executeOperation(db, {
    operation: 'START_COLLECTION', executionArn: 'arn', collectionStartedAt: '2026-08-23T15:00:00Z',
    stream: { youtubeChannelId: 'channel', channelName: 'channel', youtubeVideoId: 'video',
      youtubeLiveChatId: 'chat', title: 'title', startedAt: '2026-08-23T15:00:00Z' },
  }), { streamId: '1', collectionJobId: '2' });
  assert.equal(db.calls.filter((call) => call.text.trim().startsWith('INSERT')).length, 3);
});

test('START_COLLECTION updates only allowed changed business fields and never ended_at', async () => {
  const db = new ScriptedDatabase([
    result([], 0), result([{ id: '10', name: 'old', url: 'old' }]), result([], 1),
    result([], 0), result([stream({ title: 'old', started_at: '2026-08-23T14:00:00Z', url: 'old', ended_at: '2026-08-23T17:00:00Z' })]),
    result([], 1), result([job()]),
  ]);
  await executeOperation(db, {
    operation: 'START_COLLECTION', executionArn: 'arn', collectionStartedAt: '2026-08-23T15:00:00Z',
    stream: { youtubeChannelId: 'channel', channelName: 'channel', youtubeVideoId: 'video',
      youtubeLiveChatId: 'chat', title: 'title', startedAt: '2026-08-23T15:00:00Z' },
  });
  const updates = db.calls.filter((call) => call.text.trim().startsWith('UPDATE'));
  assert.equal(updates.length, 2);
  assert.equal(updates.every((call) => /updated_at/.test(call.text)), true);
  assert.equal(updates.some((call) => /SET[^]*ended_at/.test(call.text)), false);
});

test('START_COLLECTION rejects a different immutable live chat ID', async () => {
  const db = new ScriptedDatabase([
    result([{ id: '10', name: 'channel', url: 'https://www.youtube.com/channel/channel' }]),
    result([], 0), result([stream({ youtube_live_chat_id: 'other' })]),
  ]);
  await assert.rejects(executeOperation(db, {
    operation: 'START_COLLECTION', executionArn: 'arn', collectionStartedAt: '2026-08-23T15:00:00Z',
    stream: { youtubeChannelId: 'channel', channelName: 'channel', youtubeVideoId: 'video',
      youtubeLiveChatId: 'chat', title: 'title', startedAt: '2026-08-23T15:00:00Z' },
  }), (error: unknown) => error instanceof StreamMetadataError && error.classification === 'STATE_CONFLICT');
});

test('START_COLLECTION rejects channel and collection job identity conflicts', async () => {
  const channelConflict = new ScriptedDatabase([
    result([{ id: '10', name: 'channel', url: 'https://www.youtube.com/channel/channel' }]),
    result([], 0), result([stream({ channel_id: '99' })]),
  ]);
  const input = { operation: 'START_COLLECTION' as const, executionArn: 'arn', collectionStartedAt: '2026-08-23T15:00:00Z',
    stream: { youtubeChannelId: 'channel', channelName: 'channel', youtubeVideoId: 'video',
      youtubeLiveChatId: 'chat', title: 'title', startedAt: '2026-08-23T15:00:00Z' } };
  await assert.rejects(executeOperation(channelConflict, input), StreamMetadataError);

  const jobConflict = new ScriptedDatabase([
    result([{ id: '10', name: 'channel', url: 'https://www.youtube.com/channel/channel' }]),
    result([stream()]), result([], 0), result([job({ execution_arn: 'different' })]),
  ]);
  await assert.rejects(executeOperation(jobConflict, input), StreamMetadataError);
});

test('REGISTER_BATCHES accepts an exact duplicate and reports descriptor count', async () => {
  const sha = 'a'.repeat(64);
  const db = new ScriptedDatabase([
    result([job()]), result([{ started_at: '2026-08-23T15:00:00Z' }]), result([], 0),
    result([{ analysis_start_at: '2026-08-23T15:01:00Z' }]), result([], 0),
    result([{ outbox_object_key: 'key', payload_sha256: sha }]),
  ]);
  const output = await executeOperation(db, { operation: 'REGISTER_BATCHES', streamId: '1', collectionJobId: '2',
    executionArn: 'arn', observationStartedAt: '2026-08-23T15:01:00Z',
    batches: [{ batchId: `batch-v1-${sha}`, outboxObjectKey: 'key', payloadSha256: sha }] });
  assert.deepEqual(output, { registeredBatchCount: 1 });
});

test('REGISTER_BATCHES initializes observation and metrics even when batches is empty', async () => {
  const db = new ScriptedDatabase([
    result([job({ observation_started_at: null })]), result([], 1),
    result([{ started_at: '2026-08-23T15:00:00Z' }]), result([], 1),
  ]);
  assert.deepEqual(await executeOperation(db, { operation: 'REGISTER_BATCHES', streamId: '1', collectionJobId: '2',
    executionArn: 'arn', observationStartedAt: '2026-08-23T15:01:00Z', batches: [] }), { registeredBatchCount: 0 });
  assert.match(db.calls[1].text, /observation_started_at/);
  assert.match(db.calls[3].text, /INSERT INTO stream_metrics/);
});

test('REGISTER_BATCHES rejects observation and metrics retry mismatches', async () => {
  const observation = new ScriptedDatabase([result([job({ observation_started_at: '2026-08-23T15:02:00Z' })])]);
  const input = { operation: 'REGISTER_BATCHES' as const, streamId: '1', collectionJobId: '2', executionArn: 'arn',
    observationStartedAt: '2026-08-23T15:01:00Z', batches: [] };
  await assert.rejects(executeOperation(observation, input), StreamMetadataError);

  const metrics = new ScriptedDatabase([
    result([job()]), result([{ started_at: '2026-08-23T15:00:00Z' }]), result([], 0),
    result([{ analysis_start_at: '2026-08-23T15:02:00Z' }]),
  ]);
  await assert.rejects(executeOperation(metrics, input), StreamMetadataError);
});

for (const mismatch of ['object', 'sha'] as const) {
  test(`REGISTER_BATCHES rejects duplicate ${mismatch} mismatch`, async () => {
    const sha = 'a'.repeat(64);
    const db = new ScriptedDatabase([
      result([job()]), result([{ started_at: '2026-08-23T15:00:00Z' }]), result([], 1), result([], 0),
      result([{ outbox_object_key: mismatch === 'object' ? 'different' : 'key', payload_sha256: mismatch === 'sha' ? 'b'.repeat(64) : sha }]),
    ]);
    await assert.rejects(executeOperation(db, { operation: 'REGISTER_BATCHES', streamId: '1', collectionJobId: '2',
      executionArn: 'arn', observationStartedAt: '2026-08-23T15:01:00Z',
      batches: [{ batchId: `batch-v1-${sha}`, outboxObjectKey: 'key', payloadSha256: sha }] }), StreamMetadataError);
  });
}

test('STOP_COLLECTION transitions RUNNING to COMPLETED and verifies prerequisite metrics', async () => {
  const db = new ScriptedDatabase([
    result([job()]), result([stream()]), result([{ stream_id: '1' }]), result([], 1), result([], 1),
  ]);
  const output = await executeOperation(db, { operation: 'STOP_COLLECTION', streamId: '1', collectionJobId: '2', executionArn: 'arn',
    youtubeVideoId: 'video', title: 'final', startedAt: '2026-08-23T15:00:00Z', endedAt: '2026-08-23T16:00:00Z',
    collectionStoppedAt: '2026-08-23T16:00:10Z', collectionStatus: 'COMPLETED', lastPageToken: null,
    collectedCommentCount: '3', stopReason: 'STREAM_ENDED', errorCode: null });
  assert.deepEqual(output, { streamId: '1', collectionJobId: '2', collectionStatus: 'COMPLETED', analysisStatus: 'FINALIZING' });
  assert.equal(db.calls[3].values?.[3], '2026-08-23T16:00:00Z');
});

test('STOP_COLLECTION transitions RUNNING to FAILED without requiring metrics', async () => {
  const db = new ScriptedDatabase([result([job()]), result([stream()]), result([], 1), result([], 1)]);
  const output = await executeOperation(db, { operation: 'STOP_COLLECTION', streamId: '1', collectionJobId: '2', executionArn: 'arn',
    youtubeVideoId: 'video', title: 'title', startedAt: '2026-08-23T15:00:00Z', endedAt: null,
    collectionStoppedAt: '2026-08-23T16:00:10Z', collectionStatus: 'FAILED', lastPageToken: 'token',
    collectedCommentCount: '3', stopReason: 'ERROR', errorCode: 'FAIL' });
  assert.equal((output as { analysisStatus: string }).analysisStatus, 'FAILED');
  assert.equal(db.calls[2].values?.[3], null);
  assert.equal(db.calls[3].values?.[2], 'FAILED');
});

test('STOP_COLLECTION exact terminal retry does not update', async () => {
  const terminalJob = job({ collection_status: 'COMPLETED', analysis_status: 'FINALIZING', collection_stopped_at: '2026-08-23 16:00:10+00',
    collected_comment_count: '3', stop_reason: 'END' });
  const db = new ScriptedDatabase([result([terminalJob]), result([stream({ started_at: '2026-08-23 15:00:00+00', ended_at: '2026-08-23 16:00:00+00' })])]);
  await executeOperation(db, { operation: 'STOP_COLLECTION', streamId: '1', collectionJobId: '2', executionArn: 'arn',
    youtubeVideoId: 'video', title: 'title', startedAt: '2026-08-23T15:00:00Z', endedAt: '2026-08-23T16:00:00Z',
    collectionStoppedAt: '2026-08-23T16:00:10Z', collectionStatus: 'COMPLETED', lastPageToken: null,
    collectedCommentCount: '3', stopReason: 'END', errorCode: null });
  assert.equal(db.calls.length, 2);
});

test('STOP_COLLECTION FAILED preserves an existing ended_at when input endedAt is null and exact retry succeeds', async () => {
  const existingEndedAt = '2026-08-23T16:00:00Z';
  const input = { operation: 'STOP_COLLECTION' as const, streamId: '1', collectionJobId: '2', executionArn: 'arn',
    youtubeVideoId: 'video', title: 'title', startedAt: '2026-08-23T15:00:00Z', endedAt: null,
    collectionStoppedAt: '2026-08-23T16:00:10Z', collectionStatus: 'FAILED' as const, lastPageToken: null,
    collectedCommentCount: '3', stopReason: 'ERROR', errorCode: 'FAIL' };
  const db = new ScriptedDatabase([
    result([job()]), result([stream({ ended_at: existingEndedAt })]), result([], 1), result([], 1),
  ]);
  const output = await executeOperation(db, input);
  assert.equal((output as { analysisStatus: string }).analysisStatus, 'FAILED');
  assert.match(db.calls[2].text, /UPDATE streams/);
  assert.equal(db.calls[2].values?.[3], existingEndedAt);
  assert.match(db.calls[3].text, /UPDATE collection_jobs/);
  assert.equal(db.calls[3].values?.[2], 'FAILED');

  const terminalJob = job({ collection_status: 'FAILED', analysis_status: 'FAILED',
    collection_stopped_at: input.collectionStoppedAt, collected_comment_count: '3', stop_reason: 'ERROR', error_code: 'FAIL' });
  const retry = new ScriptedDatabase([result([terminalJob]), result([stream({ ended_at: existingEndedAt })])]);
  assert.equal((await executeOperation(retry, input) as { analysisStatus: string }).analysisStatus, 'FAILED');
  assert.equal(retry.calls.length, 2);
});

test('STOP_COLLECTION rejects a different non-null ended_at but accepts the same PostgreSQL instant', async () => {
  const existingEndedAt = '2026-08-23 16:00:00.000002+00';
  const base = { operation: 'STOP_COLLECTION' as const, streamId: '1', collectionJobId: '2', executionArn: 'arn',
    youtubeVideoId: 'video', title: 'title', startedAt: '2026-08-23T15:00:00Z',
    collectionStoppedAt: '2026-08-23T16:00:10Z', collectionStatus: 'FAILED' as const, lastPageToken: null,
    collectedCommentCount: '3', stopReason: 'ERROR', errorCode: 'FAIL' };
  const mismatch = new ScriptedDatabase([result([job()]), result([stream({ ended_at: existingEndedAt })])]);
  await assert.rejects(executeOperation(mismatch, { ...base, endedAt: '2026-08-23T17:00:00Z' }), StreamMetadataError);

  const same = new ScriptedDatabase([
    result([job()]), result([stream({ ended_at: existingEndedAt })]), result([], 1), result([], 1),
  ]);
  assert.equal((await executeOperation(same, { ...base, endedAt: '2026-08-23T16:00:00.0000025Z' }) as
    { analysisStatus: string }).analysisStatus, 'FAILED');
});

test('STOP_COLLECTION terminal retry compares youtubeVideoId and only permits FAILED ended_at recovery', async () => {
  const terminalJob = job({ collection_status: 'FAILED', analysis_status: 'FAILED', collection_stopped_at: '2026-08-23T16:00:10Z',
    collected_comment_count: '3', stop_reason: 'ERROR', error_code: 'FAIL' });
  const recovery = new ScriptedDatabase([result([terminalJob]), result([stream()]), result([], 1)]);
  const input = { operation: 'STOP_COLLECTION' as const, streamId: '1', collectionJobId: '2', executionArn: 'arn', youtubeVideoId: 'video',
    title: 'title', startedAt: '2026-08-23T15:00:00Z', endedAt: '2026-08-23T16:00:00Z',
    collectionStoppedAt: '2026-08-23T16:00:10Z', collectionStatus: 'FAILED' as const, lastPageToken: null,
    collectedCommentCount: '3', stopReason: 'ERROR', errorCode: 'FAIL' };
  assert.equal((await executeOperation(recovery, input) as { analysisStatus: string }).analysisStatus, 'FAILED');
  assert.match(recovery.calls[2].text, /SET ended_at/);

  const mismatch = new ScriptedDatabase([result([terminalJob]), result([stream()])]);
  await assert.rejects(executeOperation(mismatch, { ...input, youtubeVideoId: 'different' }), StreamMetadataError);
});

test('MARK_ANALYSIS_FAILED never regresses COMPLETED and preserves FAILED without UPDATE', async () => {
  for (const analysisStatus of ['COMPLETED', 'FAILED'] as const) {
    const db = new ScriptedDatabase([result([job({ collection_status: 'COMPLETED', analysis_status: analysisStatus })])]);
    const output = await executeOperation(db, { operation: 'MARK_ANALYSIS_FAILED', streamId: '1', collectionJobId: '2', executionArn: 'arn', errorCode: 'NEW' });
    assert.equal((output as { analysisStatus: string }).analysisStatus, analysisStatus);
    assert.equal(db.calls.length, 1);
  }
});

for (const analysisStatus of ['PENDING', 'FINALIZING'] as const) {
  test(`MARK_ANALYSIS_FAILED changes ${analysisStatus} to FAILED`, async () => {
    const db = new ScriptedDatabase([result([job({ collection_status: 'COMPLETED', analysis_status: analysisStatus })]), result([], 1)]);
    const output = await executeOperation(db, { operation: 'MARK_ANALYSIS_FAILED', streamId: '1', collectionJobId: '2', executionArn: 'arn', errorCode: 'FAIL' });
    assert.equal((output as { analysisStatus: string }).analysisStatus, 'FAILED');
    assert.match(db.calls[1].text, /analysis_status = 'FAILED'/);
  });
}

test('MARK_ANALYSIS_FAILED rejects a RUNNING collection', async () => {
  const db = new ScriptedDatabase([result([job()])]);
  await assert.rejects(executeOperation(db, { operation: 'MARK_ANALYSIS_FAILED', streamId: '1', collectionJobId: '2', executionArn: 'arn', errorCode: 'FAIL' }), StreamMetadataError);
});
