import assert from 'node:assert/strict';
import { CloudFormationCustomResourceEvent, Context } from 'aws-lambda';
import test from 'node:test';
import {
  createHandler,
  ResponseRequest,
  sendCloudFormationResponse,
} from '../lambda/migration/handler';

const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);

function event(
  requestType: 'Create' | 'Update' | 'Delete',
  currentHash = hashA,
  oldHash = hashB,
): CloudFormationCustomResourceEvent {
  return {
    RequestType: requestType,
    ServiceToken: 'token',
    ResponseURL: 'https://example.com/response',
    StackId: 'stack-id',
    RequestId: 'request-id',
    ResourceType: 'Custom::DatabaseMigration',
    LogicalResourceId: 'DatabaseMigration',
    ResourceProperties: { ServiceToken: 'token', MigrationBundleHash: currentHash },
    OldResourceProperties: { ServiceToken: 'token', MigrationBundleHash: oldHash },
    PhysicalResourceId: 'stream-insight-dev-database-migration',
  } as unknown as CloudFormationCustomResourceEvent;
}

const context = {
  awsRequestId: 'aws-request-id',
  getRemainingTimeInMillis: () => 300_000,
} as Context;

function fixture(runFailure?: Error) {
  const runs: number[] = [];
  const responses: Array<{ status: string; reason: string; physicalResourceId: string }> = [];
  const handler = createHandler({
    runMigrations: async () => {
      runs.push(1);
      if (runFailure) throw runFailure;
    },
    sendResponse: async (_event, status, reason, physicalResourceId) => {
      responses.push({ status, reason, physicalResourceId });
    },
  });
  return { handler, runs, responses };
}

test('Create runs migrations and sends SUCCESS with stable physical ID', async () => {
  process.env.ENVIRONMENT = 'dev';
  const subject = fixture();
  await subject.handler(event('Create'), context);
  assert.equal(subject.runs.length, 1);
  assert.deepEqual(subject.responses, [{
    status: 'SUCCESS',
    reason: 'Migration request completed',
    physicalResourceId: 'stream-insight-dev-database-migration',
  }]);
});

test('Update runs migrations only when bundle hash changes', async () => {
  process.env.ENVIRONMENT = 'dev';
  const changed = fixture();
  await changed.handler(event('Update', hashA, hashB), context);
  assert.equal(changed.runs.length, 1);

  const unchanged = fixture();
  await unchanged.handler(event('Update', hashA, hashA), context);
  assert.equal(unchanged.runs.length, 0);
  assert.equal(unchanged.responses[0].status, 'SUCCESS');
});

test('Delete is a no-op and sends SUCCESS', async () => {
  delete process.env.ENVIRONMENT;
  const subject = fixture();
  await subject.handler(event('Delete'), context);
  assert.equal(subject.runs.length, 0);
  assert.equal(subject.responses[0].status, 'SUCCESS');
  assert.equal(subject.responses[0].physicalResourceId, 'stream-insight-dev-database-migration');
});

test('migration failure sends FAILED without exposing the error message', async () => {
  process.env.ENVIRONMENT = 'dev';
  const subject = fixture(new Error('secret details'));
  await subject.handler(event('Create'), context);
  assert.equal(subject.responses[0].status, 'FAILED');
  assert.doesNotMatch(subject.responses[0].reason, /secret details/);
});

test('CloudFormation response sender creates recognized SUCCESS and FAILED PUT bodies', async () => {
  const requests: ResponseRequest[] = [];
  const request = async (responseRequest: ResponseRequest) => {
    requests.push(responseRequest);
    return 200;
  };

  await sendCloudFormationResponse(
    event('Create'),
    'SUCCESS',
    'completed',
    'physical-id',
    { request },
  );
  await sendCloudFormationResponse(
    event('Create'),
    'FAILED',
    'safe failure',
    'physical-id',
    { request },
  );

  assert.equal(requests.length, 2);
  for (const responseRequest of requests) {
    assert.equal(responseRequest.method, 'PUT');
    assert.equal(responseRequest.headers['content-type'], '');
    assert.equal(responseRequest.headers['content-length'], responseRequest.body.length);
    assert.equal(responseRequest.timeoutMs, 3_000);
  }
  assert.deepEqual(JSON.parse(requests[0].body.toString('utf8')), {
    Status: 'SUCCESS',
    Reason: 'completed',
    PhysicalResourceId: 'physical-id',
    StackId: 'stack-id',
    RequestId: 'request-id',
    LogicalResourceId: 'DatabaseMigration',
  });
  assert.deepEqual(JSON.parse(requests[1].body.toString('utf8')), {
    Status: 'FAILED',
    Reason: 'safe failure',
    PhysicalResourceId: 'physical-id',
    StackId: 'stack-id',
    RequestId: 'request-id',
    LogicalResourceId: 'DatabaseMigration',
  });
});

test('CloudFormation response sender retries timeout and non-2xx responses only three times', async () => {
  let attempts = 0;
  const delays: number[] = [];
  await assert.rejects(
    sendCloudFormationResponse(event('Create'), 'FAILED', 'safe', 'physical-id', {
      request: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('timeout at https://example.com/response');
        return 500;
      },
      sleep: async (delay) => {
        delays.push(delay);
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'CloudFormation response failed after retries' &&
      !error.message.includes('example.com'),
  );
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [100, 200]);
});
