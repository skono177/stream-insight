import { DataCollectorError } from './errors';
import { normalizeTimestamp } from './timestamps';

export interface YouTubeVideo {
  readonly youtubeVideoId: string;
  readonly youtubeChannelId: string;
  readonly channelName: string;
  readonly title: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly youtubeLiveChatId: string | null;
  readonly streamStatus: 'UPCOMING' | 'LIVE' | 'ENDED';
}

export interface YouTubeCommentPage {
  readonly responseNextPageToken: string;
  readonly pollingIntervalMillis: number;
  readonly offlineAt: string | null;
  readonly items: readonly unknown[];
}

export interface YouTubeClient {
  getVideo(videoId: string): Promise<YouTubeVideo>;
  getComments(liveChatId: string, pageToken: string | null): Promise<YouTubeCommentPage>;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DataCollectorError('UNEXPECTED', `YouTube response is missing ${label}`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function errorReason(body: unknown): string | undefined {
  const error = record(record(body)?.error);
  const errors = error?.errors;
  if (Array.isArray(errors)) {
    const reason = record(errors[0])?.reason;
    if (typeof reason === 'string') return reason;
  }
  const status = error?.status;
  return typeof status === 'string' ? status : undefined;
}

function youtubeError(status: number, reason?: string): DataCollectorError {
  const normalized = reason ?? 'unknown';
  if (normalized === 'liveChatEnded') return new DataCollectorError('LIVE_CHAT_ENDED', 'The live chat has ended', normalized, status);
  if (normalized === 'liveChatDisabled' || normalized === 'liveChatNotFound') {
    return new DataCollectorError('LIVE_CHAT_UNAVAILABLE', 'The live chat is unavailable', normalized, status);
  }
  if (normalized === 'quotaExceeded' || normalized === 'dailyLimitExceeded') {
    return new DataCollectorError('YOUTUBE_QUOTA', 'YouTube quota was exceeded', normalized, status);
  }
  if (normalized === 'keyInvalid' || normalized === 'ipRefererBlocked' || status === 401) {
    return new DataCollectorError('YOUTUBE_AUTHENTICATION', 'YouTube authentication failed', normalized, status);
  }
  if (normalized === 'forbidden' || normalized === 'insufficientPermissions') {
    return new DataCollectorError('YOUTUBE_AUTHORIZATION', 'YouTube authorization failed', normalized, status);
  }
  if (status === 429 || status >= 500 || normalized === 'rateLimitExceeded') {
    return new DataCollectorError('YOUTUBE_TRANSIENT', 'YouTube request failed transiently', normalized, status);
  }
  if (normalized === 'videoNotFound') {
    return new DataCollectorError('LIVE_CHAT_UNAVAILABLE', 'The YouTube video was not found', normalized, status);
  }
  return new DataCollectorError('UNEXPECTED', 'YouTube request failed', normalized, status);
}

export class ApiKeyYouTubeClient implements YouTubeClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImplementation: Fetch = fetch,
  ) {}

  private async request(path: string, parameters: URLSearchParams): Promise<unknown> {
    const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
    url.search = parameters.toString();
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        method: 'GET',
        headers: { 'x-goog-api-key': this.apiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new DataCollectorError('YOUTUBE_TRANSIENT', 'YouTube request could not be completed', undefined, undefined, { cause: error });
    }
    let body: unknown;
    try { body = await response.json(); } catch (error) {
      throw new DataCollectorError(response.ok ? 'UNEXPECTED' : 'YOUTUBE_TRANSIENT',
        'YouTube returned an invalid JSON response', undefined, response.status, { cause: error });
    }
    if (!response.ok) throw youtubeError(response.status, errorReason(body));
    return body;
  }

  async getVideo(videoId: string): Promise<YouTubeVideo> {
    const body = record(await this.request('videos', new URLSearchParams({
      part: 'snippet,liveStreamingDetails', id: videoId,
    })));
    const items = body?.items;
    if (!Array.isArray(items) || items.length !== 1) {
      throw new DataCollectorError('LIVE_CHAT_UNAVAILABLE', 'YouTube video was not found or response was ambiguous');
    }
    const item = record(items[0]);
    if (item?.id !== videoId) throw new DataCollectorError('UNEXPECTED', 'YouTube returned a different video ID');
    const snippet = record(item.snippet);
    const live = record(item.liveStreamingDetails);
    if (!snippet || !live) throw new DataCollectorError('UNEXPECTED', 'YouTube video response is incomplete');
    const actualStart = optionalString(live.actualStartTime);
    const actualEnd = optionalString(live.actualEndTime);
    const streamStatus = actualEnd !== null ? 'ENDED' : actualStart !== null ? 'LIVE' : 'UPCOMING';
    return {
      youtubeVideoId: videoId,
      youtubeChannelId: requiredString(snippet.channelId, 'snippet.channelId'),
      channelName: requiredString(snippet.channelTitle, 'snippet.channelTitle'),
      title: requiredString(snippet.title, 'snippet.title'),
      startedAt: actualStart === null ? null : normalizeTimestamp(actualStart, 'actualStartTime'),
      endedAt: actualEnd === null ? null : normalizeTimestamp(actualEnd, 'actualEndTime'),
      youtubeLiveChatId: optionalString(live.activeLiveChatId),
      streamStatus,
    };
  }

  async getComments(liveChatId: string, pageToken: string | null): Promise<YouTubeCommentPage> {
    const parameters = new URLSearchParams({ part: 'id,snippet', liveChatId });
    if (pageToken !== null) parameters.set('pageToken', pageToken);
    const body = record(await this.request('liveChat/messages', parameters));
    const nextPageToken = requiredString(body?.nextPageToken, 'nextPageToken');
    const pollingIntervalMillis = body?.pollingIntervalMillis;
    if (typeof pollingIntervalMillis !== 'number' || !Number.isSafeInteger(pollingIntervalMillis) || pollingIntervalMillis < 0) {
      throw new DataCollectorError('UNEXPECTED', 'YouTube response has an invalid pollingIntervalMillis');
    }
    if (!Array.isArray(body?.items)) throw new DataCollectorError('UNEXPECTED', 'YouTube response has invalid items');
    const offlineAt = optionalString(body.offlineAt);
    return {
      responseNextPageToken: nextPageToken,
      pollingIntervalMillis,
      offlineAt: offlineAt === null ? null : normalizeTimestamp(offlineAt, 'offlineAt'),
      items: body.items,
    };
  }
}
