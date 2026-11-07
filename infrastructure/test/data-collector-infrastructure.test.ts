import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BackendStack } from '../lib/backend-stack';
import { NetworkStack } from '../lib/network-stack';
import { StorageStack } from '../lib/storage-stack';

let cached: Template | undefined;
function template(): Template {
  if (cached) return cached;
  const app = new App({ context: { environment: 'dev' } });
  const env = { account: '123456789012', region: 'ap-northeast-1' };
  const network = new NetworkStack(app, 'network-data-collector', { env });
  const storage = new StorageStack(app, 'storage-data-collector', { env, vpc: network.vpc });
  const backend = new BackendStack(app, 'backend-data-collector', { env, databaseCluster: storage.databaseCluster,
    rawDataBucket: storage.rawDataBucket, vpc: network.vpc, applicationSecurityGroup: network.applicationSecurityGroup });
  cached = Template.fromStack(backend);
  return cached;
}

test('Data Collector is outside VPC with fixed runtime, capacity and non-secret environment', () => {
  const functions = template().findResources('AWS::Lambda::Function');
  const fn = Object.values(functions).find((item) => item.Properties?.FunctionName === 'stream-insight-dev-data-collector');
  assert.ok(fn);
  assert.equal(fn.Properties.Runtime, 'nodejs24.x');
  assert.equal(fn.Properties.MemorySize, 512);
  assert.equal(fn.Properties.Timeout, 60);
  assert.equal(fn.Properties.ReservedConcurrentExecutions, 2);
  assert.equal('VpcConfig' in fn.Properties, false);
  assert.deepEqual(fn.Properties.Environment.Variables.YOUTUBE_AUTH_MODE, 'API_KEY');
  assert.deepEqual(fn.Properties.Environment.Variables.YOUTUBE_API_KEY_PARAMETER_NAME,
    '/stream-insight/dev/youtube/api-key');
  assert.equal(fn.Properties.Environment.Variables.MAX_MESSAGE_BODY_BYTES, '921600');
  const environment = JSON.stringify(fn.Properties.Environment.Variables);
  assert.doesNotMatch(environment, /AIza|API_KEY_VALUE|oauth|refresh.?token/i);
});

test('creates encrypted Standard queue and DLQ with the designed retention and redrive settings', () => {
  const queues = Object.values(template().findResources('AWS::SQS::Queue'));
  const source = queues.find((item) => item.Properties?.QueueName === 'stream-insight-dev-comment-queue');
  const dlq = queues.find((item) => item.Properties?.QueueName === 'stream-insight-dev-comment-dlq');
  assert.ok(source && dlq);
  assert.equal(source.Properties.MessageRetentionPeriod, 345600);
  assert.equal(source.Properties.VisibilityTimeout, 360);
  assert.equal(source.Properties.SqsManagedSseEnabled, true);
  assert.equal(source.Properties.RedrivePolicy.maxReceiveCount, 5);
  assert.match(JSON.stringify(source.Properties.RedrivePolicy.deadLetterTargetArn), /CommentDeadLetterQueue/);
  assert.equal(dlq.Properties.MessageRetentionPeriod, 1209600);
  assert.equal(dlq.Properties.SqsManagedSseEnabled, true);
});

test('Data Collector IAM is limited to logs, outbox objects, one queue and one parameter', () => {
  const roles = template().findResources('AWS::IAM::Role');
  const role = Object.entries(roles).find(([, item]) => item.Properties?.RoleName === 'stream-insight-dev-data-collector');
  assert.ok(role);
  const policies = Object.values(template().findResources('AWS::IAM::Policy')).filter((item) =>
    item.Properties?.Roles?.some((entry: unknown) => JSON.stringify(entry) === JSON.stringify({ Ref: role[0] })));
  assert.equal(policies.length, 1);
  const statements = policies[0].Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown }>;
  const actions = statements.flatMap((item) => typeof item.Action === 'string' ? [item.Action] : item.Action).sort();
  assert.deepEqual(actions, ['logs:CreateLogStream', 'logs:PutLogEvents', 's3:GetObject', 's3:PutObject',
    'sqs:SendMessage', 'ssm:GetParameter'].sort());
  const resources = JSON.stringify(statements.map((item) => item.Resource));
  assert.match(resources, /outbox\/\*/);
  assert.match(resources, /CommentQueue/);
  assert.match(resources, /parameter\/stream-insight\/dev\/youtube\/api-key/);
  assert.doesNotMatch(actions.join(','), /rds|ec2|secretsmanager|kms/i);
});
