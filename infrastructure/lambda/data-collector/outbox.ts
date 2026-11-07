import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DataCollectorError, awsErrorCode, awsErrorName, awsHttpStatus, awsPermanentError,
  isAwsAuthorizationError, isAwsServerError, isAwsThrottling, isAwsTimeout, isAwsTransportError } from './errors';
import { sha256 } from './serialization';

export interface ObjectStore {
  get(key: string): Promise<Uint8Array | null>;
  putIfAbsent(key: string, bytes: Uint8Array): Promise<'stored' | 'exists'>;
}

export class S3ObjectStore implements ObjectStore {
  constructor(private readonly client: S3Client, private readonly bucketName: string) {}

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucketName, Key: key }), {
        abortSignal: AbortSignal.timeout(10_000),
      });
      if (!result.Body) throw new DataCollectorError('OUTBOX_INTEGRITY', 'S3 object has no body');
      return await result.Body.transformToByteArray();
    } catch (error) {
      if (error instanceof DataCollectorError) throw error;
      const name = awsErrorName(error);
      const reason = awsErrorCode(error) ?? name;
      const status = awsHttpStatus(error);
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      if (isAwsTimeout(name) || isAwsTransportError(error) || isAwsThrottling(name, status) || isAwsServerError(status)) {
        throw new DataCollectorError('S3_TRANSIENT', 'S3 GetObject failed transiently', reason, status, { cause: error });
      }
      throw awsPermanentError('S3 GetObject failed permanently', name, status, error);
    }
  }

  async putIfAbsent(key: string, bytes: Uint8Array): Promise<'stored' | 'exists'> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.client.send(new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Body: bytes,
          ContentType: 'application/json; charset=utf-8',
          IfNoneMatch: '*',
        }), { abortSignal: AbortSignal.timeout(10_000) });
        return 'stored';
      } catch (error) {
        const name = awsErrorName(error);
        const reason = awsErrorCode(error) ?? name;
        const status = awsHttpStatus(error);
        if (name === 'PreconditionFailed' || status === 412) return 'exists';
        if ((name === 'ConditionalRequestConflict' || status === 409) && attempt === 0) continue;
        if (name === 'ConditionalRequestConflict' || status === 409 || isAwsTimeout(name) || isAwsTransportError(error) ||
            isAwsThrottling(name, status) || isAwsServerError(status)) {
          throw new DataCollectorError('S3_TRANSIENT', 'S3 PutObject failed transiently', reason, status, { cause: error });
        }
        if (isAwsAuthorizationError(name, status) || status !== undefined) {
          throw awsPermanentError('S3 PutObject failed permanently', name, status, error);
        }
        throw new DataCollectorError('UNEXPECTED', 'S3 PutObject failed unexpectedly', reason, status, { cause: error });
      }
    }
    throw new DataCollectorError('S3_TRANSIENT', 'S3 PutObject conflict did not resolve');
  }
}

export async function writeFirstWriterWins(
  store: ObjectStore,
  key: string,
  bytes: Uint8Array,
): Promise<{ readonly bytes: Uint8Array; readonly created: boolean }> {
  const existing = await store.get(key);
  if (existing !== null) return { bytes: existing, created: false };
  try {
    const outcome = await store.putIfAbsent(key, bytes);
    if (outcome === 'stored') return { bytes, created: true };
  } catch (error) {
    if (!(error instanceof DataCollectorError) || error.classification !== 'S3_TRANSIENT') throw error;
    const afterUnknown = await store.get(key);
    if (afterUnknown !== null) return { bytes: afterUnknown, created: false };
    throw error;
  }
  const winner = await store.get(key);
  if (winner === null) throw new DataCollectorError('S3_TRANSIENT', 'Conditionally stored object could not be read');
  return { bytes: winner, created: false };
}

export async function writeImmutable(
  store: ObjectStore,
  key: string,
  bytes: Uint8Array,
  expectedSha256: string,
): Promise<void> {
  const result = await writeFirstWriterWins(store, key, bytes);
  if (sha256(result.bytes) !== expectedSha256) {
    throw new DataCollectorError('OUTBOX_CONFLICT', 'Existing outbox object has different bytes');
  }
}

export async function getRequired(store: ObjectStore, key: string): Promise<Uint8Array> {
  const bytes = await store.get(key);
  if (bytes === null) throw new DataCollectorError('OUTBOX_EXPIRED', 'Required outbox object does not exist');
  return bytes;
}
