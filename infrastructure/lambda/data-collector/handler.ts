import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { Context } from 'aws-lambda';
import { DataCollectorOutput } from './contracts';
import { DataCollectorError, awsErrorCode, awsErrorName, awsHttpStatus, awsPermanentError,
  isAwsServerError, isAwsThrottling, isAwsTimeout, isAwsTransportError } from './errors';
import { consoleLogger, Logger } from './logging';
import { executeOperation, OperationDependencies } from './operations';
import { S3ObjectStore } from './outbox';
import { SqsMessageQueue } from './queue';
import { validateInput } from './validation';
import { ApiKeyYouTubeClient, YouTubeClient, YouTubeCommentPage, YouTubeVideo } from './youtube';

const s3Client = new S3Client({});
const sqsClient = new SQSClient({});
const ssmClient = new SSMClient({});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new DataCollectorError('UNEXPECTED', `Required environment variable is missing: ${name}`);
  return value;
}

export interface ParameterReader { getParameter(name: string): Promise<string> }

export class SsmParameterReader implements ParameterReader {
  constructor(private readonly client: SSMClient) {}
  async getParameter(name: string): Promise<string> {
    try {
      const result = await this.client.send(new GetParameterCommand({ Name: name, WithDecryption: true }), {
        abortSignal: AbortSignal.timeout(10_000),
      });
      const value = result.Parameter?.Value;
      if (!value) throw new DataCollectorError('AWS_RESOURCE_NOT_FOUND', 'YouTube API Key parameter has no value');
      return value;
    } catch (error) {
      if (error instanceof DataCollectorError) throw error;
      const nameValue = awsErrorName(error);
      const reason = awsErrorCode(error) ?? nameValue;
      const status = awsHttpStatus(error);
      if (isAwsTimeout(nameValue) || isAwsTransportError(error) || isAwsThrottling(nameValue, status) ||
          isAwsServerError(status)) {
        throw new DataCollectorError('SSM_TRANSIENT', 'YouTube API Key could not be retrieved transiently',
          reason, status, { cause: error });
      }
      throw awsPermanentError('YouTube API Key could not be retrieved', nameValue, status, error);
    }
  }
}

export class CachedApiKeyProvider {
  private cached?: Promise<string>;
  constructor(private readonly reader: ParameterReader, private readonly parameterName: string) {}
  get(): Promise<string> {
    if (!this.cached) {
      this.cached = this.reader.getParameter(this.parameterName).catch((error: unknown) => {
        this.cached = undefined;
        throw error;
      });
    }
    return this.cached;
  }
  refresh(): Promise<string> {
    this.cached = undefined;
    return this.get();
  }
}

export class RefreshingYouTubeClient implements YouTubeClient {
  constructor(
    private readonly provider: CachedApiKeyProvider,
    private readonly clientFactory: (apiKey: string) => YouTubeClient = (apiKey) => new ApiKeyYouTubeClient(apiKey),
    private readonly canRefresh: () => boolean = () => true,
  ) {}
  private async execute<T>(operation: (client: YouTubeClient) => Promise<T>): Promise<T> {
    const firstKey = await this.provider.get();
    try {
      return await operation(this.clientFactory(firstKey));
    } catch (error) {
      if (!(error instanceof DataCollectorError) || error.classification !== 'YOUTUBE_AUTHENTICATION') throw error;
      if (!this.canRefresh()) {
        throw new DataCollectorError('TIME_BUDGET', 'Insufficient time remains to refresh the YouTube API Key',
          error.externalReason, error.httpStatus, { cause: error });
      }
      const refreshedKey = await this.provider.refresh();
      if (refreshedKey === firstKey) throw error;
      return operation(this.clientFactory(refreshedKey));
    }
  }
  async getVideo(videoId: string): Promise<YouTubeVideo> {
    return this.execute((client) => client.getVideo(videoId));
  }
  async getComments(liveChatId: string, pageToken: string | null): Promise<YouTubeCommentPage> {
    return this.execute((client) => client.getComments(liveChatId, pageToken));
  }
}

const apiKeyReaders = new Map<string, CachedApiKeyProvider>();
function youtubeClient(parameterName: string, canRefresh: () => boolean): YouTubeClient {
  let provider = apiKeyReaders.get(parameterName);
  if (!provider) {
    provider = new CachedApiKeyProvider(new SsmParameterReader(ssmClient), parameterName);
    apiKeyReaders.set(parameterName, provider);
  }
  return new RefreshingYouTubeClient(provider, undefined, canRefresh);
}

function productionDependencies(context: Context): OperationDependencies {
  if (requiredEnvironment('YOUTUBE_AUTH_MODE') !== 'API_KEY') {
    throw new DataCollectorError('UNEXPECTED', 'YOUTUBE_AUTH_MODE must be API_KEY');
  }
  const maximum = Number(requiredEnvironment('MAX_MESSAGE_BODY_BYTES'));
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1_048_576) {
    throw new DataCollectorError('UNEXPECTED', 'MAX_MESSAGE_BODY_BYTES is invalid');
  }
  return {
    youtube: youtubeClient(requiredEnvironment('YOUTUBE_API_KEY_PARAMETER_NAME'),
      () => context.getRemainingTimeInMillis() > 22_000),
    store: new S3ObjectStore(s3Client, requiredEnvironment('RAW_DATA_BUCKET_NAME')),
    queue: new SqsMessageQueue(sqsClient, requiredEnvironment('COMMENT_QUEUE_URL')),
    maxMessageBodyBytes: maximum,
    now: () => new Date(),
    remainingTimeInMillis: () => context.getRemainingTimeInMillis(),
  };
}

export function createHandler(
  dependenciesFactory: (context: Context) => OperationDependencies,
  logger: Logger = consoleLogger,
): (event: unknown, context: Context) => Promise<DataCollectorOutput> {
  return async (event, context) => {
    const startedAt = Date.now();
    let operation: string | undefined;
    let streamId: string | undefined;
    let collectionJobId: string | undefined;
    try {
      const input = validateInput(event);
      operation = input.operation;
      streamId = 'streamId' in input ? input.streamId : undefined;
      collectionJobId = 'collectionJobId' in input ? input.collectionJobId : undefined;
      if (context.getRemainingTimeInMillis() <= 12_000) {
        throw new DataCollectorError('TIME_BUDGET', 'Insufficient time remains to start the operation');
      }
      const output = await executeOperation(input, dependenciesFactory(context));
      logger.log({ event: 'operation_succeeded', awsRequestId: context.awsRequestId, operation,
        streamId, collectionJobId, elapsedMs: Date.now() - startedAt });
      return output;
    } catch (error) {
      const classified = error instanceof DataCollectorError
        ? error : new DataCollectorError('UNEXPECTED', 'Unexpected data collector failure', undefined, undefined, { cause: error });
      logger.log({ event: 'operation_failed', awsRequestId: context.awsRequestId, operation, streamId, collectionJobId,
        classification: classified.classification, externalReason: classified.externalReason,
        httpStatus: classified.httpStatus, elapsedMs: Date.now() - startedAt });
      throw classified;
    }
  };
}

export const handler = createHandler(productionDependencies);
