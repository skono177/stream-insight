import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDatabaseError } from '../lambda/stream-metadata/errors';
import { consoleLogger } from '../lambda/stream-metadata/logging';

for (const [code, phase, expected] of [
  ['28P01', 'connection', 'DB_AUTHENTICATION'],
  ['28000', 'connection', 'DB_AUTHENTICATION'],
  ['42501', 'query', 'DB_AUTHORIZATION'],
  ['23505', 'query', 'DB_CONSTRAINT'],
  ['08006', 'connection', 'DB_CONNECTION_TRANSIENT'],
  ['40001', 'query', 'DB_TRANSACTION_TRANSIENT'],
  ['40P01', 'query', 'DB_TRANSACTION_TRANSIENT'],
  ['99999', 'query', 'UNEXPECTED'],
] as const) {
  test(`classifies SQLSTATE ${code} as ${expected}`, () => {
    assert.equal(classifyDatabaseError({ code }, phase).classification, expected);
  });
}

test('structured logging emits only explicitly allowed safe fields', () => {
  const output: string[] = [];
  const original = console.log;
  console.log = (value?: unknown): void => { output.push(String(value)); };
  try {
    consoleLogger.log({ event: 'failed', operation: 'START_COLLECTION', classification: 'DB_AUTHENTICATION', postgresCode: '28P01' });
  } finally {
    console.log = original;
  }
  assert.deepEqual(JSON.parse(output[0]), {
    event: 'failed', operation: 'START_COLLECTION', classification: 'DB_AUTHENTICATION', postgresCode: '28P01',
  });
  assert.doesNotMatch(output[0], /password|token|connectionString|SELECT|INSERT/);
});
