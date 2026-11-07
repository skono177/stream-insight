import assert from 'node:assert/strict';
import test from 'node:test';
import { S3Client } from '@aws-sdk/client-s3';
import { DataCollectorError } from '../lambda/data-collector/errors';
import { ObjectStore, S3ObjectStore, writeFirstWriterWins, writeImmutable } from '../lambda/data-collector/outbox';
import { sha256 } from '../lambda/data-collector/serialization';

class FakeS3Client {
  calls = 0;
  constructor(private readonly outcomes: readonly ('ok' | 409 | 412)[]) {}

  async send(): Promise<Record<string, never>> {
    const outcome = this.outcomes[this.calls] ?? this.outcomes[this.outcomes.length - 1];
    this.calls += 1;
    if (outcome === 'ok') return {};
    if (outcome === 412) {
      throw { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } };
    }
    throw { name: 'ConditionalRequestConflict', $metadata: { httpStatusCode: 409 } };
  }
}

const store = (client: FakeS3Client): S3ObjectStore =>
  new S3ObjectStore(client as unknown as S3Client, 'bucket');

test('S3 conditional Put treats 412 as an existing immutable object', async () => {
  const client = new FakeS3Client([412]);
  assert.equal(await store(client).putIfAbsent('outbox/key.json', Buffer.from('{}')), 'exists');
  assert.equal(client.calls, 1);
});

test('S3 conditional Put retries one 409 and succeeds', async () => {
  const client = new FakeS3Client([409, 'ok']);
  assert.equal(await store(client).putIfAbsent('outbox/key.json', Buffer.from('{}')), 'stored');
  assert.equal(client.calls, 2);
});

test('S3 conditional Put classifies a continuing 409 as transient', async () => {
  const client = new FakeS3Client([409, 409]);
  await assert.rejects(() => store(client).putIfAbsent('outbox/key.json', Buffer.from('{}')), (error: unknown) =>
    error instanceof DataCollectorError && error.classification === 'S3_TRANSIENT' && error.httpStatus === 409);
  assert.equal(client.calls, 2);
});

class SequencedStore implements ObjectStore {
  gets = 0;
  constructor(
    private readonly getResults: readonly (Uint8Array | null)[],
    private readonly putResult: 'exists' | DataCollectorError,
  ) {}
  async get(): Promise<Uint8Array | null> {
    const value = this.getResults[Math.min(this.gets, this.getResults.length - 1)];
    this.gets += 1;
    return value?.slice() ?? null;
  }
  async putIfAbsent(): Promise<'stored' | 'exists'> {
    if (this.putResult instanceof DataCollectorError) throw this.putResult;
    return this.putResult;
  }
}

test('412 path GETs and verifies the existing immutable Object bytes', async () => {
  const expected = Buffer.from('{"winner":true}');
  const matching = new SequencedStore([null, expected], 'exists');
  await writeImmutable(matching, 'outbox/key.json', expected, sha256(expected));
  assert.equal(matching.gets, 2);

  const different = new SequencedStore([null, Buffer.from('{"other":true}')], 'exists');
  await assert.rejects(() => writeImmutable(different, 'outbox/key.json', expected, sha256(expected)),
    (error: unknown) => error instanceof DataCollectorError && error.classification === 'OUTBOX_CONFLICT');
});

test('recovers a saved Object after an unknown Put outcome', async () => {
  const bytes = Buffer.from('{"saved":true}');
  const store = new SequencedStore([null, bytes],
    new DataCollectorError('S3_TRANSIENT', 'unknown', 'TimeoutError'));
  const result = await writeFirstWriterWins(store, 'outbox/key.json', bytes);
  assert.equal(result.created, false);
  assert.deepEqual(result.bytes, bytes);
});

test('continuing 409 recovers an existing Object and preserves failure when absent', async () => {
  const bytes = Buffer.from('{"saved":true}');
  const conflict = new DataCollectorError('S3_TRANSIENT', 'conflict', 'ConditionalRequestConflict', 409);
  const existing = new SequencedStore([null, bytes], conflict);
  assert.deepEqual((await writeFirstWriterWins(existing, 'outbox/key.json', bytes)).bytes, bytes);

  const absent = new SequencedStore([null, null], conflict);
  await assert.rejects(() => writeFirstWriterWins(absent, 'outbox/key.json', bytes), (error: unknown) =>
    error instanceof DataCollectorError && error.externalReason === 'ConditionalRequestConflict');
});
