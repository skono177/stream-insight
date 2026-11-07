import assert from 'node:assert/strict';
import test from 'node:test';
import { SSMClient } from '@aws-sdk/client-ssm';
import { Context } from 'aws-lambda';
import { DataCollectorError } from '../lambda/data-collector/errors';
import { CachedApiKeyProvider, createHandler, ParameterReader, RefreshingYouTubeClient,
  SsmParameterReader } from '../lambda/data-collector/handler';
import { Logger } from '../lambda/data-collector/logging';
import { OperationDependencies } from '../lambda/data-collector/operations';
import { YouTubeClient, YouTubeVideo } from '../lambda/data-collector/youtube';

class SequenceReader implements ParameterReader {
  calls = 0;
  constructor(private readonly values: readonly string[]) {}
  async getParameter(): Promise<string> {
    const value = this.values[Math.min(this.calls, this.values.length - 1)];
    this.calls += 1;
    return value;
  }
}

const endedVideo = (id: string): YouTubeVideo => ({
  youtubeVideoId: id, youtubeChannelId: 'channel', channelName: 'name', title: 'title',
  startedAt: '2026-01-01T00:00:00.000000Z', endedAt: '2026-01-01T01:00:00.000000Z',
  youtubeLiveChatId: null, streamStatus: 'ENDED',
});

test('refreshes the cached API Key once after authentication failure', async () => {
  const reader = new SequenceReader(['old-key', 'new-key']);
  const provider = new CachedApiKeyProvider(reader, '/parameter');
  const usedKeys: string[] = [];
  const client = new RefreshingYouTubeClient(provider, (key): YouTubeClient => ({
    async getVideo(id) {
      usedKeys.push(key);
      if (key === 'old-key') throw new DataCollectorError('YOUTUBE_AUTHENTICATION', 'invalid key');
      return endedVideo(id);
    },
    async getComments() { throw new Error('not used'); },
  }));
  assert.equal((await client.getVideo('video')).streamStatus, 'ENDED');
  assert.deepEqual(usedKeys, ['old-key', 'new-key']);
  assert.equal(reader.calls, 2);
});

test('does not retry YouTube with the same refreshed key or more than once', async () => {
  for (const values of [['same-key', 'same-key'], ['old-key', 'new-key']] as const) {
    const reader = new SequenceReader(values);
    const provider = new CachedApiKeyProvider(reader, '/parameter');
    let attempts = 0;
    const client = new RefreshingYouTubeClient(provider, (): YouTubeClient => ({
      async getVideo() { attempts += 1; throw new DataCollectorError('YOUTUBE_AUTHENTICATION', 'invalid key'); },
      async getComments() { throw new Error('not used'); },
    }));
    await assert.rejects(() => client.getVideo('video'), (error: unknown) =>
      error instanceof DataCollectorError && error.classification === 'YOUTUBE_AUTHENTICATION');
    assert.equal(attempts, values[0] === values[1] ? 1 : 2);
    assert.equal(reader.calls, 2);
  }
});

test('does not refresh the API Key when the Lambda time budget is unsafe', async () => {
  const reader = new SequenceReader(['old-key', 'new-key']);
  const provider = new CachedApiKeyProvider(reader, '/parameter');
  let attempts = 0;
  const client = new RefreshingYouTubeClient(provider, (): YouTubeClient => ({
    async getVideo() { attempts += 1; throw new DataCollectorError('YOUTUBE_AUTHENTICATION', 'invalid key'); },
    async getComments() { throw new Error('not used'); },
  }), () => false);

  await assert.rejects(() => client.getVideo('video'), (error: unknown) =>
    error instanceof DataCollectorError && error.classification === 'TIME_BUDGET');
  assert.equal(attempts, 1);
  assert.equal(reader.calls, 1);
});

test('classifies SSM timeout, missing parameter and access denial separately', async () => {
  for (const [outcome, classification] of [
    [{ name: 'TimeoutError' }, 'SSM_TRANSIENT'],
    [{ name: 'ParameterNotFound', $metadata: { httpStatusCode: 400 } }, 'AWS_RESOURCE_NOT_FOUND'],
    [{ name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } }, 'AWS_AUTHORIZATION'],
  ] as const) {
    const client = { send: async () => { throw outcome; } } as unknown as SSMClient;
    await assert.rejects(() => new SsmParameterReader(client).getParameter('/parameter'), (error: unknown) =>
      error instanceof DataCollectorError && error.classification === classification);
  }
  const empty = { send: async () => ({ Parameter: {} }) } as unknown as SSMClient;
  await assert.rejects(() => new SsmParameterReader(empty).getParameter('/parameter'), (error: unknown) =>
    error instanceof DataCollectorError && error.classification === 'AWS_RESOURCE_NOT_FOUND');
});

test('handler logs only allowlisted metadata and never event secrets', async () => {
  const entries: unknown[] = [];
  const logger: Logger = { log: (fields) => entries.push(fields) };
  const dependencies = {
    youtube: { async getVideo() { throw new DataCollectorError('YOUTUBE_AUTHENTICATION', 'invalid', 'keyInvalid', 400); },
      async getComments() { throw new Error('not used'); } },
    store: { async get() { return null; }, async putIfAbsent() { return 'stored' as const; } },
    queue: { async send() {} }, maxMessageBodyBytes: 921_600, now: () => new Date(),
  } satisfies OperationDependencies;
  const context = { awsRequestId: 'request-id', getRemainingTimeInMillis: () => 60_000 } as Context;
  const handler = createHandler(() => dependencies, logger);
  await assert.rejects(() => handler({ operation: 'GET_STREAM_METADATA', youtubeVideoId: 'secret-video-id' }, context));
  const serialized = JSON.stringify(entries);
  assert.doesNotMatch(serialized, /secret-video-id|api.?key|comment|messagebody/i);
  assert.match(serialized, /YOUTUBE_AUTHENTICATION|keyInvalid/);
});
