import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { DataCollectorError } from '../lambda/data-collector/errors';
import { batchId, canonicalJson, sha256, splitBatches, sqsJson } from '../lambda/data-collector/serialization';
import { normalizeTimestamp } from '../lambda/data-collector/timestamps';

test('canonical-json-v1 and sqs-json-v1 match the cross-language golden vector', () => {
  const fixture = JSON.parse(readFileSync(join(__dirname, '..', '..', 'test', 'fixtures',
    'canonical-json-v1-golden.json'), 'utf8')) as {
      input: unknown;
      expected: { canonicalUtf8Hex: string; canonicalSha256: string; sqsUtf8Hex: string; sqsSha256: string };
      timestamps: Array<{ input: string; expected: string }>;
    };
  const canonical = canonicalJson(fixture.input);
  const sqs = sqsJson(fixture.input);
  assert.equal(Buffer.from(canonical).toString('hex'), fixture.expected.canonicalUtf8Hex);
  assert.equal(sha256(canonical), fixture.expected.canonicalSha256);
  assert.equal(Buffer.from(sqs).toString('hex'), fixture.expected.sqsUtf8Hex);
  assert.equal(sha256(sqs), fixture.expected.sqsSha256);
  assert.equal(sqs.includes('\ufffe') || sqs.includes('\uffff'), false);
  assert.equal(sqs.includes('\\ufffe\\uffff'), true);
  assert.deepEqual(JSON.parse(sqs), fixture.input);
  for (const vector of fixture.timestamps) assert.equal(normalizeTimestamp(vector.input), vector.expected);
});

test('batch ID matches the documented vector and preserves Unicode', () => {
  const comments = [
    { commentId: 'comment-001', text: 'こんにちは😀', publishedAt: '2026-08-23T15:00:00.000000Z' },
    { commentId: 'comment-002', text: '今日も楽しみ', publishedAt: '2026-08-23T15:00:05.000000Z' },
  ];
  assert.equal(batchId('1', 'youtube-video-id', comments),
    'batch-v1-e2e817de548b360a66572dd6975b987d1fae2f1ca893a3b6f0480c767bc4bd81');
  const documented = comments.map((comment) => ({ ...comment, text: comment.text.replace('😀', '') }));
  assert.equal(batchId('1', 'youtube-video-id', documented),
    'batch-v1-f74f263ac0f120c3af6837f4ed5c6cb5bdc22445ed55236e96253bc090e5d25d');
});

test('rejects unpaired surrogates and a single oversized comment', () => {
  assert.throws(() => canonicalJson(['\ud800']), (error: unknown) =>
    error instanceof DataCollectorError && error.classification === 'VALIDATION');
  assert.throws(() => splitBatches('1', '1', '2026-01-01T00:00:00.000000Z', 'video', [
    { commentId: 'id', text: '長'.repeat(1_000), publishedAt: '2026-01-01T00:00:00.000000Z' },
  ], 200), (error: unknown) => error instanceof DataCollectorError && error.classification === 'MESSAGE_TOO_LARGE');
});

test('greedy splitting is deterministic and measures the final SQS body bytes', () => {
  const comments = Array.from({ length: 12 }, (_, index) => ({
    commentId: `id-${index.toString().padStart(2, '0')}`,
    text: `${'日😀'.repeat(20)}${index}`,
    publishedAt: '2026-01-01T00:00:00.000000Z',
  }));
  const first = splitBatches('1', '2', '2026-01-01T00:00:00.000000Z', 'video', comments, 900);
  const second = splitBatches('1', '2', '2026-01-01T00:00:00.000000Z', 'video', comments, 900);
  assert.deepEqual(first, second);
  assert.ok(first.length > 1);
  for (const batch of first) assert.ok(Buffer.byteLength(batch.body, 'utf8') <= 900);
});

test('timestamps use UTC microseconds and ties-to-even rounding', () => {
  assert.equal(normalizeTimestamp('2026-01-01T09:00:00.0000025+09:00'), '2026-01-01T00:00:00.000002Z');
  assert.equal(normalizeTimestamp('2026-01-01T00:00:00.0000035Z'), '2026-01-01T00:00:00.000004Z');
  assert.equal(normalizeTimestamp('2026-12-31T23:59:59.9999995Z'), '2027-01-01T00:00:00.000000Z');
});
