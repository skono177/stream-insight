import assert from 'node:assert/strict';
import test from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { DataCollectorError } from '../lambda/data-collector/errors';
import { S3ObjectStore } from '../lambda/data-collector/outbox';
import { SqsMessageQueue } from '../lambda/data-collector/queue';

const rejectingClient = <T>(error: unknown): T => ({ send: async () => { throw error; } }) as T;

test('separates transient, authorization and missing-resource S3 failures', async () => {
  for (const [error, classification] of [
    [{ name: 'TimeoutError' }, 'S3_TRANSIENT'],
    [{ name: 'Error', code: 'ECONNRESET' }, 'S3_TRANSIENT'],
    [{ name: 'Error', cause: { code: 'EAI_AGAIN' } }, 'S3_TRANSIENT'],
    [{ name: 'SlowDown', $metadata: { httpStatusCode: 429 } }, 'S3_TRANSIENT'],
    [{ name: 'SlowDown', $metadata: { httpStatusCode: 503 } }, 'S3_TRANSIENT'],
    [{ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }, 'AWS_AUTHORIZATION'],
    [{ name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }, 'AWS_RESOURCE_NOT_FOUND'],
    [{ name: 'InvalidBucketName', $metadata: { httpStatusCode: 400 } }, 'AWS_CONFIGURATION'],
    [{ name: 'InvalidEndpoint' }, 'AWS_CONFIGURATION'],
    [{ name: 'Error' }, 'UNEXPECTED'],
  ] as const) {
    const store = new S3ObjectStore(rejectingClient<S3Client>(error), 'bucket');
    await assert.rejects(() => store.get('outbox/key.json'), (actual: unknown) =>
      actual instanceof DataCollectorError && actual.classification === classification);
  }
});

test('separates throttling, unknown outcome and permanent SQS failures', async () => {
  for (const [error, classification] of [
    [{ name: 'ThrottlingException', $metadata: { httpStatusCode: 429 } }, 'SQS_TRANSIENT'],
    [{ name: 'TimeoutError' }, 'SQS_SEND_OUTCOME_UNKNOWN'],
    [{ name: 'Error', code: 'ECONNRESET' }, 'SQS_SEND_OUTCOME_UNKNOWN'],
    [{ name: 'Error', cause: { code: 'EAI_AGAIN' } }, 'SQS_SEND_OUTCOME_UNKNOWN'],
    [{ name: 'InternalError', $metadata: { httpStatusCode: 500 } }, 'SQS_SEND_OUTCOME_UNKNOWN'],
    [{ name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } }, 'AWS_AUTHORIZATION'],
    [{ name: 'QueueDoesNotExist', $metadata: { httpStatusCode: 400 } }, 'AWS_RESOURCE_NOT_FOUND'],
    [{ name: 'InvalidAddress', $metadata: { httpStatusCode: 400 } }, 'AWS_CONFIGURATION'],
    [{ name: 'CredentialsProviderError' }, 'AWS_CONFIGURATION'],
    [{ name: 'Error' }, 'UNEXPECTED'],
  ] as const) {
    const queue = new SqsMessageQueue(rejectingClient<SQSClient>(error), 'queue-url');
    await assert.rejects(() => queue.send('{}'), (actual: unknown) =>
      actual instanceof DataCollectorError && actual.classification === classification);
  }
});
