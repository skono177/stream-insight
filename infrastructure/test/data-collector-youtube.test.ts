import assert from 'node:assert/strict';
import test from 'node:test';
import { DataCollectorError } from '../lambda/data-collector/errors';
import { ApiKeyYouTubeClient } from '../lambda/data-collector/youtube';

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

const responseWithJsonError = (error: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => { throw error; },
} as unknown as Response);

function video(live: Record<string, unknown>): unknown {
  return { items: [{ id: 'video', snippet: { channelId: 'channel', channelTitle: 'name', title: 'title' },
    liveStreamingDetails: live }] };
}

test('classifies UPCOMING, LIVE and ENDED from actual timestamps', async () => {
  for (const [details, expected] of [
    [{ scheduledStartTime: '2026-01-01T00:00:00Z' }, 'UPCOMING'],
    [{ actualStartTime: '2026-01-01T00:00:00Z', activeLiveChatId: 'chat' }, 'LIVE'],
    [{ actualStartTime: '2026-01-01T00:00:00Z', actualEndTime: '2026-01-01T01:00:00Z' }, 'ENDED'],
  ] as const) {
    const client = new ApiKeyYouTubeClient('not-a-real-key', async () => response(video(details)));
    assert.equal((await client.getVideo('video')).streamStatus, expected);
  }
});

test('video not found and missing live chat ID are represented without guessing', async () => {
  const missing = new ApiKeyYouTubeClient('key', async () => response({ items: [] }));
  await assert.rejects(() => missing.getVideo('video'), (error: unknown) =>
    error instanceof DataCollectorError && error.classification === 'LIVE_CHAT_UNAVAILABLE');
  const noChat = new ApiKeyYouTubeClient('key', async () => response(video({ actualStartTime: '2026-01-01T00:00:00Z' })));
  const result = await noChat.getVideo('video');
  assert.equal(result.streamStatus, 'LIVE');
  assert.equal(result.youtubeLiveChatId, null);
});

test('passes pageToken and returns polling and offline metadata', async () => {
  let requested = '';
  const client = new ApiKeyYouTubeClient('key', async (input) => {
    requested = input.toString();
    return response({ nextPageToken: 'next-2', pollingIntervalMillis: 7000,
      offlineAt: '2026-01-01T01:00:00Z', items: [] });
  });
  const page = await client.getComments('chat', 'next-1');
  assert.match(requested, /pageToken=next-1/);
  assert.equal(page.pollingIntervalMillis, 7000);
  assert.equal(page.offlineAt, '2026-01-01T01:00:00.000000Z');
});

test('uses x-goog-api-key header without placing the API Key in the URL', async () => {
  let requestedUrl = '';
  let requestedHeaders: Headers | undefined;
  const client = new ApiKeyYouTubeClient('secret-api-key', async (input, init) => {
    requestedUrl = input.toString();
    requestedHeaders = new Headers(init?.headers);
    return response(video({ actualStartTime: '2026-01-01T00:00:00Z', activeLiveChatId: 'chat' }));
  });
  await client.getVideo('video');
  assert.doesNotMatch(requestedUrl, /secret-api-key|[?&]key=/);
  assert.equal(requestedHeaders?.get('x-goog-api-key'), 'secret-api-key');
});

test('classifies authentication, quota, 429, 5xx and live chat end errors', async () => {
  for (const [status, reason, classification] of [
    [400, 'keyInvalid', 'YOUTUBE_AUTHENTICATION'],
    [403, 'quotaExceeded', 'YOUTUBE_QUOTA'],
    [429, 'rateLimitExceeded', 'YOUTUBE_TRANSIENT'],
    [503, 'backendError', 'YOUTUBE_TRANSIENT'],
    [403, 'liveChatEnded', 'LIVE_CHAT_ENDED'],
    [403, 'liveChatDisabled', 'LIVE_CHAT_UNAVAILABLE'],
  ] as const) {
    const client = new ApiKeyYouTubeClient('key', async () => response({ error: { errors: [{ reason }] } }, status));
    await assert.rejects(() => client.getComments('chat', null), (error: unknown) =>
      error instanceof DataCollectorError && error.classification === classification);
  }
});

test('classifies transport failures while reading a successful response body as transient', async () => {
  const errors = [
    Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
    Object.assign(new Error('body timed out'), { name: 'TimeoutError' }),
    Object.assign(new Error('body failed'), {
      cause: Object.assign(new Error('socket timed out'), { code: 'ETIMEDOUT' }),
    }),
  ];
  for (const bodyError of errors) {
    const client = new ApiKeyYouTubeClient('key', async () => responseWithJsonError(bodyError));
    await assert.rejects(() => client.getVideo('video'), (error: unknown) =>
      error instanceof DataCollectorError && error.classification === 'YOUTUBE_TRANSIENT');
  }

  const unknown = new ApiKeyYouTubeClient('key', async () => responseWithJsonError(new Error('unknown body failure')));
  await assert.rejects(() => unknown.getVideo('video'), (error: unknown) =>
    error instanceof DataCollectorError && error.classification === 'UNEXPECTED');
});

test('rejects timeout, non-JSON and malformed YouTube responses', async () => {
  const timeout = new ApiKeyYouTubeClient('key', async () => {
    const error = new Error('timed out'); error.name = 'TimeoutError'; throw error;
  });
  await assert.rejects(() => timeout.getVideo('video'), (error: unknown) =>
    error instanceof DataCollectorError && error.classification === 'YOUTUBE_TRANSIENT');

  const nonJson = new ApiKeyYouTubeClient('key', async () => new Response('not-json', { status: 200 }));
  await assert.rejects(() => nonJson.getVideo('video'), (error: unknown) =>
    error instanceof DataCollectorError && error.classification === 'UNEXPECTED');

  for (const body of [
    { items: [], pollingIntervalMillis: 1 },
    { nextPageToken: '', pollingIntervalMillis: 1, items: [] },
    { nextPageToken: 'next', pollingIntervalMillis: -1, items: [] },
    { nextPageToken: 'next', pollingIntervalMillis: 1.5, items: [] },
  ]) {
    const malformed = new ApiKeyYouTubeClient('key', async () => response(body));
    await assert.rejects(() => malformed.getComments('chat', null), (error: unknown) =>
      error instanceof DataCollectorError && error.classification === 'UNEXPECTED');
  }

  const mismatched = new ApiKeyYouTubeClient('key', async () => response({
    items: [{ id: 'other-video', snippet: { channelId: 'channel', channelTitle: 'name', title: 'title' },
      liveStreamingDetails: { actualStartTime: '2026-01-01T00:00:00Z' } }],
  }));
  await assert.rejects(() => mismatched.getVideo('video'), (error: unknown) =>
    error instanceof DataCollectorError && error.classification === 'UNEXPECTED');
});
