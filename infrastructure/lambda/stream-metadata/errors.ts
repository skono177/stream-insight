export type ErrorClassification =
  | 'VALIDATION'
  | 'STATE_CONFLICT'
  | 'DB_AUTHENTICATION'
  | 'DB_AUTHORIZATION'
  | 'DB_CONSTRAINT'
  | 'DB_CONNECTION_TRANSIENT'
  | 'DB_TRANSACTION_TRANSIENT'
  | 'COMMIT_OUTCOME_UNKNOWN'
  | 'TIME_BUDGET'
  | 'UNEXPECTED';

export class StreamMetadataError extends Error {
  public readonly cause?: unknown;

  constructor(
    public readonly classification: ErrorClassification,
    message: string,
    public readonly postgresCode?: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message);
    this.name = classification;
    this.cause = options?.cause;
  }
}

export function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function classifyDatabaseError(
  error: unknown,
  phase: 'connection' | 'query',
): StreamMetadataError {
  if (error instanceof StreamMetadataError) return error;
  const code = postgresErrorCode(error);
  if (phase === 'connection' && (code === '28P01' || code === '28000')) {
    return new StreamMetadataError('DB_AUTHENTICATION', 'Database authentication failed', code, { cause: error });
  }
  if (phase === 'query' && code === '42501') {
    return new StreamMetadataError('DB_AUTHORIZATION', 'Database operation was not authorized', code, { cause: error });
  }
  if (code?.startsWith('23')) {
    return new StreamMetadataError('DB_CONSTRAINT', 'Database constraint rejected the operation', code, { cause: error });
  }
  if (code === '40001' || code === '40P01') {
    return new StreamMetadataError('DB_TRANSACTION_TRANSIENT', 'Database transaction failed transiently', code, { cause: error });
  }
  if (
    code?.startsWith('08') ||
    code === '57P01' ||
    code === '57P02' ||
    code === '57P03' ||
    code === '53300' ||
    ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EPIPE'].includes(code ?? '')
  ) {
    return new StreamMetadataError('DB_CONNECTION_TRANSIENT', 'Database connection failed transiently', code, { cause: error });
  }
  return new StreamMetadataError('UNEXPECTED', 'Unexpected database failure', code, { cause: error });
}

export function validationError(message: string): StreamMetadataError {
  return new StreamMetadataError('VALIDATION', message);
}

export function stateConflict(message: string): StreamMetadataError {
  return new StreamMetadataError('STATE_CONFLICT', message);
}
