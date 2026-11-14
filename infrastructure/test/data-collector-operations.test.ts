import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CollectCommentsOutput,
  SendRegisteredBatchesOutput,
} from '../lambda/data-collector/contracts';
import { DataCollectorError } from '../lambda/data-collector/errors';
import { executeOperation, OperationDependencies } from '../lambda/data-collector/operations';
import { ObjectStore } from '../lambda/data-collector/outbox';
import { MessageQueue } from '../lambda/data-collector/queue';
import { validateInput } from '../lambda/data-collector/validation';
import { YouTubeClient, YouTubeCommentPage, YouTubeVideo } from '../lambda/data-collector/youtube';
import { validateInput as validateStreamMetadataInput } from '../lambda/stream-metadata/validation';

class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  failPut = false;
  async get(key: string): Promise<Uint8Array | null> { return this.objects.get(key)?.slice() ?? null; }
  async putIfAbsent(key: string, bytes: Uint8Array): Promise<'stored' | 'exists'> {
    if (this.failPut) throw new DataCollectorError('S3_TRANSIENT', 'injected S3 failure');
    if (this.objects.has(key)) return 'exists';
    this.objects.set(key, bytes.slice());
    return 'stored';
  }
}

class MemoryQueue implements MessageQueue {
  readonly messages: string[] = [];
  fail = false;
  failAt: number | null = null;
  async send(body: string): Promise<void> {
    if (this.fail || this.messages.length === this.failAt) {
      throw new DataCollectorError('SQS_SEND_OUTCOME_UNKNOWN', 'injected SQS failure');
    }
    this.messages.push(body);
  }
}

class FakeYouTube implements YouTubeClient {
  readonly tokens: Array<string | null> = [];
  constructor(readonly pages: YouTubeCommentPage[]) {}
  async getVideo(videoId: string): Promise<YouTubeVideo> {
    return { youtubeVideoId: videoId, youtubeChannelId: 'channel', channelName: 'name', title: 'title',
      startedAt: '2026-01-01T00:00:00.000000Z', endedAt: '2026-01-01T01:00:00.000000Z',
      youtubeLiveChatId: null, streamStatus: 'ENDED' };
  }
  async getComments(_liveChatId: string, pageToken: string | null): Promise<YouTubeCommentPage> {
    this.tokens.push(pageToken);
    const page = this.pages[this.tokens.length - 1];
    if (!page) throw new Error('No fake page configured');
    return page;
  }
}

const textMessage = (id: string, text: string, publishedAt = '2026-01-01T00:00:01Z'): unknown => ({
  id, snippet: { type: 'textMessageEvent', publishedAt, textMessageDetails: { messageText: text } },
});

const initialInput = () => validateInput({
  operation: 'COLLECT_COMMENTS', streamId: '1', collectionJobId: '2', youtubeVideoId: 'video',
  youtubeLiveChatId: 'chat', streamStartedAt: '2026-01-01T00:00:00Z',
  checkpoint: { nextPageToken: null, observationStartedAt: null, pollingIntervalMillis: null, collectedCommentCount: '0' },
});

function dependencies(pages: YouTubeCommentPage[]): {
  readonly value: OperationDependencies; readonly store: MemoryStore; readonly queue: MemoryQueue; readonly youtube: FakeYouTube;
} {
  const store = new MemoryStore();
  const queue = new MemoryQueue();
  const youtube = new FakeYouTube(pages);
  return { store, queue, youtube, value: { store, queue, youtube, maxMessageBodyBytes: 921_600,
    now: () => new Date('2026-01-01T00:00:00.123Z') } };
}

test('collects, normalizes, deduplicates and reuses the same Snapshot on retry', async () => {
  const setup = dependencies([{ responseNextPageToken: 'next-1', pollingIntervalMillis: 5000, offlineAt: null, items: [
    textMessage('b', '日本語😀'), textMessage('a', '長文'.repeat(100)), textMessage('b', '日本語😀'),
    { id: 'event', snippet: { type: 'superChatEvent' } },
  ] }]);
  const first = await executeOperation(initialInput(), setup.value) as CollectCommentsOutput;
  const retry = await executeOperation(initialInput(), setup.value) as CollectCommentsOutput;
  assert.deepEqual(retry, first);
  assert.deepEqual(setup.youtube.tokens, [null]);
  assert.equal(first.pendingPage.collectedCommentCount, '2');
  assert.equal(first.pendingPage.batches.length, 1);
  const body = JSON.parse(new TextDecoder().decode(setup.store.objects.get(first.pendingPage.batches[0].outboxObjectKey)!));
  assert.deepEqual(body.comments.map((item: { commentId: string }) => item.commentId), ['a', 'b']);
  assert.equal(body.comments[1].text, '日本語😀');
});

test('handles zero comments, sends no SQS message and advances the checkpoint', async () => {
  const setup = dependencies([{ responseNextPageToken: 'next', pollingIntervalMillis: 8000, offlineAt: null, items: [] }]);
  const collected = await executeOperation(initialInput(), setup.value) as CollectCommentsOutput;
  assert.deepEqual(collected.pendingPage.batches, []);
  const sendInput = validateInput({ operation: 'SEND_REGISTERED_BATCHES', streamId: '1', collectionJobId: '2',
    registeredBatchCount: 0, pendingPage: collected.pendingPage });
  const sent = await executeOperation(sendInput, setup.value) as SendRegisteredBatchesOutput;
  assert.equal(sent.sentBatchCount, 0);
  assert.equal(sent.checkpoint.nextPageToken, 'next');
  assert.deepEqual(setup.queue.messages, []);
});

test('uses nextPageToken for the second page and preserves final offlineAt after sending', async () => {
  const setup = dependencies([
    { responseNextPageToken: 'next-1', pollingIntervalMillis: 5000, offlineAt: null, items: [textMessage('a', 'one')] },
    { responseNextPageToken: 'next-2', pollingIntervalMillis: 7000, offlineAt: '2026-01-01T01:00:00.000000Z',
      items: [textMessage('b', 'two')] },
  ]);
  const first = await executeOperation(initialInput(), setup.value) as CollectCommentsOutput;
  const sentFirst = await executeOperation(validateInput({ operation: 'SEND_REGISTERED_BATCHES', streamId: '1',
    collectionJobId: '2', registeredBatchCount: first.pendingPage.batches.length, pendingPage: first.pendingPage }), setup.value) as SendRegisteredBatchesOutput;
  const secondInput = validateInput({ operation: 'COLLECT_COMMENTS', streamId: '1', collectionJobId: '2',
    youtubeVideoId: 'video', youtubeLiveChatId: 'chat', streamStartedAt: '2026-01-01T00:00:00Z',
    checkpoint: sentFirst.checkpoint });
  const second = await executeOperation(secondInput, setup.value) as CollectCommentsOutput;
  const sentSecond = await executeOperation(validateInput({ operation: 'SEND_REGISTERED_BATCHES', streamId: '1',
    collectionJobId: '2', registeredBatchCount: second.pendingPage.batches.length, pendingPage: second.pendingPage }), setup.value) as SendRegisteredBatchesOutput;
  assert.deepEqual(setup.youtube.tokens, [null, 'next-1']);
  assert.equal(sentSecond.offlineAt, '2026-01-01T01:00:00.000000Z');
  assert.equal(sentSecond.checkpoint.collectedCommentCount, '2');
});

test('does not advance on S3 or SQS failure and can resend the same Outbox', async () => {
  const s3Setup = dependencies([{ responseNextPageToken: 'next', pollingIntervalMillis: 5000, offlineAt: null,
    items: [textMessage('a', 'one')] }]);
  s3Setup.store.failPut = true;
  await assert.rejects(() => executeOperation(initialInput(), s3Setup.value), (error: unknown) =>
    error instanceof DataCollectorError && error.classification === 'S3_TRANSIENT');

  const setup = dependencies([{ responseNextPageToken: 'next', pollingIntervalMillis: 5000, offlineAt: null,
    items: [textMessage('a', 'one')] }]);
  const collected = await executeOperation(initialInput(), setup.value) as CollectCommentsOutput;
  const sendInput = validateInput({ operation: 'SEND_REGISTERED_BATCHES', streamId: '1', collectionJobId: '2',
    registeredBatchCount: collected.pendingPage.batches.length, pendingPage: collected.pendingPage });
  setup.queue.fail = true;
  await assert.rejects(() => executeOperation(sendInput, setup.value), (error: unknown) =>
    error instanceof DataCollectorError && error.classification === 'SQS_SEND_OUTCOME_UNKNOWN');
  setup.queue.fail = false;
  const sent = await executeOperation(sendInput, setup.value) as SendRegisteredBatchesOutput;
  assert.equal(sent.sentBatchCount, 1);
  assert.equal(setup.youtube.tokens.length, 1);
});

test('resends every deterministic Outbox after a partial SQS success', async () => {
  const setup = dependencies([{ responseNextPageToken: 'next', pollingIntervalMillis: 5000, offlineAt: null,
    items: [textMessage('a', 'あ'.repeat(250)), textMessage('b', 'い'.repeat(250)), textMessage('c', 'う'.repeat(250))] }]);
  const constrained = { ...setup.value, maxMessageBodyBytes: 1_400 };
  const collected = await executeOperation(initialInput(), constrained) as CollectCommentsOutput;
  assert.ok(collected.pendingPage.batches.length > 1);
  const sendInput = validateInput({ operation: 'SEND_REGISTERED_BATCHES', streamId: '1', collectionJobId: '2',
    registeredBatchCount: collected.pendingPage.batches.length, pendingPage: collected.pendingPage });

  setup.queue.failAt = 1;
  await assert.rejects(() => executeOperation(sendInput, constrained), (error: unknown) =>
    error instanceof DataCollectorError && error.classification === 'SQS_SEND_OUTCOME_UNKNOWN');
  assert.equal(setup.queue.messages.length, 1);

  setup.queue.failAt = null;
  const sent = await executeOperation(sendInput, constrained) as SendRegisteredBatchesOutput;
  assert.equal(sent.sentBatchCount, collected.pendingPage.batches.length);
  assert.equal(setup.queue.messages.length, collected.pendingPage.batches.length + 1);
  assert.equal(setup.queue.messages[0], setup.queue.messages[1]);
  assert.equal(setup.youtube.tokens.length, 1);
});

test('fails an expired Snapshot rather than refetching YouTube', async () => {
  const setup = dependencies([{ responseNextPageToken: 'next', pollingIntervalMillis: 5000, offlineAt: null,
    items: [textMessage('a', 'one')] }]);
  const collected = await executeOperation(initialInput(), setup.value) as CollectCommentsOutput;
  setup.store.objects.delete(collected.pendingPage.snapshotObjectKey);
  const sendInput = validateInput({ operation: 'SEND_REGISTERED_BATCHES', streamId: '1', collectionJobId: '2',
    registeredBatchCount: collected.pendingPage.batches.length, pendingPage: collected.pendingPage });
  await assert.rejects(() => executeOperation(sendInput, setup.value), (error: unknown) =>
    error instanceof DataCollectorError && error.classification === 'OUTBOX_EXPIRED');
  assert.equal(setup.youtube.tokens.length, 1);
});

test('detects modified Snapshot bytes and modified Batch bytes before SQS send', async () => {
  for (const target of ['snapshot', 'batch'] as const) {
    const setup = dependencies([{ responseNextPageToken: 'next', pollingIntervalMillis: 5000, offlineAt: null,
      items: [textMessage('a', 'one')] }]);
    const collected = await executeOperation(initialInput(), setup.value) as CollectCommentsOutput;
    const key = target === 'snapshot' ? collected.pendingPage.snapshotObjectKey
      : collected.pendingPage.batches[0].outboxObjectKey;
    setup.store.objects.set(key, Buffer.from('{"tampered":true}', 'utf8'));
    const sendInput = validateInput({ operation: 'SEND_REGISTERED_BATCHES', streamId: '1', collectionJobId: '2',
      registeredBatchCount: collected.pendingPage.batches.length, pendingPage: collected.pendingPage });
    await assert.rejects(() => executeOperation(sendInput, setup.value), (error: unknown) =>
      error instanceof DataCollectorError && error.classification === 'OUTBOX_INTEGRITY');
    assert.deepEqual(setup.queue.messages, []);
  }
});

test('rejects different bytes already stored under the same Batch key', async () => {
  const setup = dependencies([{ responseNextPageToken: 'next', pollingIntervalMillis: 5000, offlineAt: null,
    items: [textMessage('a', 'one')] }]);
  const collected = await executeOperation(initialInput(), setup.value) as CollectCommentsOutput;
  setup.store.objects.set(collected.pendingPage.batches[0].outboxObjectKey, Buffer.from('{"different":true}'));
  await assert.rejects(() => executeOperation(initialInput(), setup.value), (error: unknown) =>
    error instanceof DataCollectorError && error.classification === 'OUTBOX_CONFLICT');
  assert.equal(setup.youtube.tokens.length, 1);
});

test('classifies malformed YouTube items separately from saved Outbox corruption', async () => {
  const setup = dependencies([{ responseNextPageToken: 'next', pollingIntervalMillis: 5000, offlineAt: null,
    items: [null] }]);
  await assert.rejects(() => executeOperation(initialInput(), setup.value), (error: unknown) =>
    error instanceof DataCollectorError && error.classification === 'UNEXPECTED');
});

test('produces descriptors accepted by the Stream Metadata REGISTER_BATCHES contract', async () => {
  const setup = dependencies([{ responseNextPageToken: 'next', pollingIntervalMillis: 5000, offlineAt: null,
    items: [textMessage('a', 'one')] }]);
  const collected = await executeOperation(initialInput(), setup.value) as CollectCommentsOutput;
  const register = validateStreamMetadataInput({
    operation: 'REGISTER_BATCHES', streamId: '1', collectionJobId: '2', executionArn: 'execution-arn',
    observationStartedAt: collected.pendingPage.observationStartedAt, batches: collected.pendingPage.batches,
  });
  assert.equal(register.operation, 'REGISTER_BATCHES');
});

test('returns final stream metadata without invoking comments', async () => {
  const setup = dependencies([]);
  const result = await executeOperation(validateInput({ operation: 'GET_FINAL_STREAM_METADATA', youtubeVideoId: 'video' }), setup.value);
  assert.deepEqual(result, { youtubeVideoId: 'video', title: 'title', startedAt: '2026-01-01T00:00:00.000000Z',
    endedAt: '2026-01-01T01:00:00.000000Z', streamStatus: 'ENDED' });
  assert.deepEqual(setup.youtube.tokens, []);
});

test('does not start external work when the Lambda time budget is unsafe', async () => {
  const setup = dependencies([{ responseNextPageToken: 'next', pollingIntervalMillis: 5000, offlineAt: null,
    items: [textMessage('a', 'one')] }]);
  const constrained = { ...setup.value, remainingTimeInMillis: () => 12_000 };
  await assert.rejects(() => executeOperation(initialInput(), constrained), (error: unknown) =>
    error instanceof DataCollectorError && error.classification === 'TIME_BUDGET');
  assert.deepEqual(setup.youtube.tokens, []);
  assert.equal(setup.store.objects.size, 0);
});
