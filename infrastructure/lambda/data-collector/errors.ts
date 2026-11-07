export type DataCollectorErrorClassification =
  | 'VALIDATION'
  | 'YOUTUBE_AUTHENTICATION'
  | 'YOUTUBE_AUTHORIZATION'
  | 'YOUTUBE_QUOTA'
  | 'YOUTUBE_TRANSIENT'
  | 'LIVE_CHAT_UNAVAILABLE'
  | 'LIVE_CHAT_ENDED'
  | 'AWS_AUTHORIZATION'
  | 'AWS_RESOURCE_NOT_FOUND'
  | 'AWS_CONFIGURATION'
  | 'SSM_TRANSIENT'
  | 'S3_TRANSIENT'
  | 'OUTBOX_CONFLICT'
  | 'OUTBOX_INTEGRITY'
  | 'OUTBOX_EXPIRED'
  | 'SQS_TRANSIENT'
  | 'SQS_SEND_OUTCOME_UNKNOWN'
  | 'COMMENT_ID_CONFLICT'
  | 'MESSAGE_TOO_LARGE'
  | 'TIME_BUDGET'
  | 'UNEXPECTED';

export class DataCollectorError extends Error {
  public readonly cause?: unknown;

  constructor(
    public readonly classification: DataCollectorErrorClassification,
    message: string,
    public readonly externalReason?: string,
    public readonly httpStatus?: number,
    options?: { readonly cause?: unknown },
  ) {
    super(message);
    this.name = classification;
    this.cause = options?.cause;
  }
}

export const validationError = (message: string): DataCollectorError =>
  new DataCollectorError('VALIDATION', message);

export function awsErrorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as { readonly name?: unknown }).name;
  return typeof value === 'string' ? value : undefined;
}

export function awsHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { readonly $metadata?: { readonly httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return typeof status === 'number' ? status : undefined;
}

function errorChain(error: unknown): readonly Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === 'object' && current !== null && !seen.has(current) && chain.length < 5) {
    seen.add(current);
    const item = current as Record<string, unknown>;
    chain.push(item);
    current = item.cause;
  }
  return chain;
}

export function awsErrorCode(error: unknown): string | undefined {
  for (const item of errorChain(error)) {
    if (typeof item.code === 'string') return item.code;
  }
  return undefined;
}

const TIMEOUT_NAMES = new Set(['AbortError', 'TimeoutError', 'RequestTimeout', 'RequestTimeoutException']);
const THROTTLING_NAMES = new Set([
  'Throttling', 'ThrottlingException', 'TooManyRequestsException', 'RequestThrottled', 'RequestThrottledException',
]);
const AUTHORIZATION_NAMES = new Set(['AccessDenied', 'AccessDeniedException', 'Forbidden', 'UnauthorizedException']);
const TRANSPORT_ERROR_IDENTIFIERS = new Set([
  'AbortError', 'TimeoutError', 'RequestTimeout', 'RequestTimeoutException', 'NetworkingError', 'ConnectionError',
  'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  'ESOCKETTIMEDOUT', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
]);
const CONFIGURATION_NAMES = new Set([
  'CredentialsProviderError', 'EndpointError', 'InvalidAddress', 'InvalidBucketName', 'InvalidEndpoint',
  'InvalidParameter', 'InvalidParameterException', 'SerializationException', 'ValidationError', 'ValidationException',
]);

export const isAwsTimeout = (name?: string): boolean => name !== undefined && TIMEOUT_NAMES.has(name);
export const isAwsThrottling = (name?: string, status?: number): boolean =>
  status === 429 || (name !== undefined && THROTTLING_NAMES.has(name));
export const isAwsServerError = (status?: number): boolean => status !== undefined && status >= 500;
export const isAwsAuthorizationError = (name?: string, status?: number): boolean =>
  status === 401 || status === 403 || (name !== undefined && AUTHORIZATION_NAMES.has(name));
export function isAwsTransportError(error: unknown): boolean {
  return errorChain(error).some((item) =>
    (typeof item.name === 'string' && TRANSPORT_ERROR_IDENTIFIERS.has(item.name)) ||
    (typeof item.code === 'string' && TRANSPORT_ERROR_IDENTIFIERS.has(item.code)));
}

export function awsPermanentError(
  message: string,
  name?: string,
  status?: number,
  cause?: unknown,
): DataCollectorError {
  const classification = isAwsAuthorizationError(name, status) ? 'AWS_AUTHORIZATION'
    : status === 404 || name?.includes('NotFound') || name?.includes('NotExist') ? 'AWS_RESOURCE_NOT_FOUND'
      : (status !== undefined && status >= 400 && status < 500) ||
        (name !== undefined && CONFIGURATION_NAMES.has(name)) ? 'AWS_CONFIGURATION' : 'UNEXPECTED';
  return new DataCollectorError(classification, message, name, status, { cause });
}
