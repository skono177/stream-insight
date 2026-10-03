import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import test from 'node:test';
import { BackendStack } from '../lib/backend-stack';
import { NetworkStack } from '../lib/network-stack';
import { StorageStack } from '../lib/storage-stack';

let cachedTemplates: { backend: Template; storage: Template; network: Template } | undefined;
function templates(): { backend: Template; storage: Template; network: Template } {
  if (cachedTemplates) return cachedTemplates;
  const app = new App({ context: { environment: 'dev' } });
  const env = { account: '123456789012', region: 'ap-northeast-1' };
  const network = new NetworkStack(app, 'network', { env });
  const storage = new StorageStack(app, 'storage', { env, vpc: network.vpc });
  const backend = new BackendStack(app, 'backend', { env, databaseCluster: storage.databaseCluster,
    vpc: network.vpc, applicationSecurityGroup: network.applicationSecurityGroup });
  cachedTemplates = { backend: Template.fromStack(backend), storage: Template.fromStack(storage), network: Template.fromStack(network) };
  return cachedTemplates;
}

test('Stream Metadata Lambda has fixed runtime, timeout, concurrency, VPC and non-secret DB environment', () => {
  const { backend } = templates();
  const functions = backend.findResources('AWS::Lambda::Function');
  const resource = Object.values(functions).find((item) => item.Properties?.FunctionName === 'stream-insight-dev-stream-metadata');
  assert.ok(resource);
  assert.equal(resource.Properties.Runtime, 'nodejs24.x');
  assert.equal(resource.Properties.MemorySize, 256);
  assert.equal(resource.Properties.Timeout, 60);
  assert.equal(resource.Properties.ReservedConcurrentExecutions, 1);
  assert.ok(resource.Properties.VpcConfig);
  backend.resourceCountIs('AWS::EC2::SecurityGroup', 0);
  const variables = resource.Properties.Environment.Variables;
  assert.equal(variables.DB_NAME, 'stream_insight');
  assert.equal(variables.DB_USER, 'stream_metadata_user');
  assert.equal(variables.RDS_CA_BUNDLE_PATH, '/var/task/assets/global-bundle.pem');
  assert.equal('SECRET_ARN' in variables, false);
  assert.ok(resource.DependsOn.some((value: string) => value.includes('DatabaseMigration')));
  const logs = backend.findResources('AWS::Logs::LogGroup');
  const logGroup = Object.values(logs).find((item) => item.Properties?.LogGroupName === '/aws/lambda/stream-insight-dev-stream-metadata');
  assert.equal(logGroup?.Properties?.RetentionInDays, 7);
});

test('IAM grants only connect, logs and ENI actions with no Secrets Manager permission', () => {
  const { backend } = templates();
  const roles = backend.findResources('AWS::IAM::Role');
  const roleEntry = Object.entries(roles).find(([, item]) => item.Properties?.RoleName === 'stream-insight-dev-stream-metadata');
  assert.ok(roleEntry);
  const policies = Object.values(backend.findResources('AWS::IAM::Policy'))
    .filter((item) => item.Properties?.Roles?.some((role: unknown) =>
      JSON.stringify(role) === JSON.stringify({ Ref: roleEntry[0] })));
  assert.equal(policies.length, 1);
  const statements = policies[0].Properties.PolicyDocument.Statement as Array<{ Action: string | string[]; Resource: unknown }>;
  const connect = statements.filter((statement) => statement.Action === 'rds-db:connect');
  assert.equal(connect.length, 1);
  const connectResource = JSON.stringify(connect[0].Resource);
  assert.match(connectResource, /:dbuser:/);
  assert.match(connectResource, /DBClusterResourceId/);
  assert.match(connectResource, /\/stream_metadata_user/);
  assert.doesNotMatch(connectResource, /\*/);
  const actions = statements.flatMap((statement) => typeof statement.Action === 'string' ? [statement.Action] : statement.Action);
  assert.ok(actions.includes('ec2:CreateNetworkInterface'));
  assert.equal(actions.some((action) => action === 'secretsmanager:GetSecretValue'), false);
  assert.equal(actions.some((action) => action.startsWith('rds-data:')), false);
  assert.equal(actions.some((action) => action.startsWith('rds:')), false);
});

test('Aurora ingress is restricted to the application security group and migration SQL is least privilege', () => {
  const { storage, network } = templates();
  storage.resourceCountIs('AWS::EC2::SecurityGroupIngress', 1);
  const ingress = Object.values(storage.findResources('AWS::EC2::SecurityGroupIngress'))[0].Properties;
  const cluster = Object.values(storage.findResources('AWS::RDS::DBCluster'))[0];
  assert.equal(cluster.Properties.Port, 5432);
  assert.equal(ingress.IpProtocol, 'tcp');
  assert.deepEqual(ingress.FromPort, ingress.ToPort);
  assert.match(JSON.stringify(ingress.FromPort), /DatabaseCluster.*Endpoint\.Port/);
  assert.match(JSON.stringify(ingress.GroupId), /AuroraSecurityGroup.*GroupId/);
  assert.match(JSON.stringify(ingress.SourceSecurityGroupId), /ApplicationSecurityGroup.*GroupId/);
  for (const property of ['CidrIp', 'CidrIpv6', 'PrefixListId']) assert.equal(property in ingress, false);
  network.resourceCountIs('AWS::EC2::NatGateway', 0);
  network.resourceCountIs('AWS::EC2::VPCEndpoint', 1);
  storage.resourceCountIs('AWS::RDS::DBProxy', 0);
  const sql = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'lambda', 'migration', 'migrations', '002_stream_metadata_user', '001_stream_metadata_user.sql'),
    'utf8',
  ) as string;
  assert.match(sql, /GRANT rds_iam TO stream_metadata_user/);
  assert.doesNotMatch(sql, /DELETE|CREATE ON SCHEMA|TRUNCATE|ALL PRIVILEGES/);
});
