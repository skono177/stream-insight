import { request } from 'node:https';
import { join } from 'node:path';
import { CloudFormationCustomResourceEvent, Context } from 'aws-lambda';
import { RdsDataApi } from './data-api';
import { discoverMigrations, MigrationError } from './migration-definition';
import { MigrationRunner } from './migration-runner';

const MIGRATIONS_ROOT = join(__dirname, 'migrations');
const HASH_PATTERN = /^[0-9a-f]{64}$/;

type ResponseStatus = 'SUCCESS' | 'FAILED';

export interface ResponseRequest {
  readonly url: URL;
  readonly method: 'PUT';
  readonly headers: {
    readonly 'content-type': '';
    readonly 'content-length': number;
  };
  readonly body: Buffer;
  readonly timeoutMs: number;
}

export interface ResponseSenderDependencies {
  readonly request?: (request: ResponseRequest) => Promise<number>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface HandlerDependencies {
  readonly runMigrations?: (
    migrationRoot: string,
    remainingTime: () => number,
  ) => Promise<void>;
  readonly sendResponse?: (
    event: CloudFormationCustomResourceEvent,
    status: ResponseStatus,
    reason: string,
    physicalResourceId: string,
  ) => Promise<void>;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new MigrationError('CONFIGURATION', `Required environment variable is missing: ${name}`);
  }
  return value;
}

function bundleHash(properties: Record<string, unknown> | undefined): string {
  const value = properties?.MigrationBundleHash;
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new MigrationError('CONFIGURATION', 'MigrationBundleHash is invalid');
  }
  return value;
}

function errorCode(error: unknown): string {
  return error instanceof MigrationError ? error.code : 'UNEXPECTED';
}

function safeLog(entry: Record<string, unknown>): void {
  console.log(JSON.stringify(entry));
}

async function defaultRunMigrations(
  migrationRoot: string,
  remainingTime: () => number,
): Promise<void> {
  const definitions = discoverMigrations(migrationRoot);
  const dataApi = new RdsDataApi({
    resourceArn: requiredEnvironment('CLUSTER_ARN'),
    secretArn: requiredEnvironment('SECRET_ARN'),
    database: requiredEnvironment('DATABASE_NAME'),
    remainingTime,
  });
  const runner = new MigrationRunner(dataApi, { remainingTime, log: safeLog });
  await runner.run(definitions);
}

function putResponse(response: ResponseRequest): Promise<number> {
  return new Promise((resolve, reject) => {
    const responseRequest = request(
      response.url,
      {
        method: response.method,
        headers: response.headers,
      },
      (incoming) => {
        incoming.resume();
        resolve(incoming.statusCode ?? 0);
      },
    );
    responseRequest.on('error', () => {
      reject(new MigrationError('RESPONSE_SEND', 'CloudFormation response could not be sent'));
    });
    responseRequest.setTimeout(response.timeoutMs, () => {
      responseRequest.destroy(
        new MigrationError('RESPONSE_SEND', 'CloudFormation response timed out'),
      );
    });
    responseRequest.end(response.body);
  });
}

export async function sendCloudFormationResponse(
  event: CloudFormationCustomResourceEvent,
  status: ResponseStatus,
  reason: string,
  physicalResourceId: string,
  dependencies: ResponseSenderDependencies = {},
): Promise<void> {
  const body = Buffer.from(
    JSON.stringify({
      Status: status,
      Reason: reason,
      PhysicalResourceId: physicalResourceId,
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
    }),
  );
  const responseUrl = new URL(event.ResponseURL);
  const responseRequest = dependencies.request ?? putResponse;
  const sleep = dependencies.sleep ?? ((milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const statusCode = await responseRequest({
        url: responseUrl,
        method: 'PUT',
        headers: {
          'content-type': '',
          'content-length': body.length,
        },
        body,
        timeoutMs: 3_000,
      });
      if (statusCode >= 200 && statusCode < 300) return;
    } catch {
      // Retry below without retaining URL-derived transport errors.
    }
    if (attempt < 3) {
      await sleep(attempt * 100);
    }
  }
  throw new MigrationError('RESPONSE_SEND', 'CloudFormation response failed after retries');
}

export function createHandler(dependencies: HandlerDependencies = {}) {
  const runMigrations = dependencies.runMigrations ?? defaultRunMigrations;
  const responseSender = dependencies.sendResponse ?? sendCloudFormationResponse;

  return async (event: CloudFormationCustomResourceEvent, context: Context): Promise<void> => {
    const environment = process.env.ENVIRONMENT;
    const physicalResourceId = event.RequestType === 'Delete' && 'PhysicalResourceId' in event
      ? event.PhysicalResourceId
      : environment
        ? `stream-insight-${environment}-database-migration`
        : 'stream-insight-configuration-error-database-migration';
    const startedAt = Date.now();
    safeLog({
      event: 'custom_resource_request',
      requestType: event.RequestType,
      logicalResourceId: event.LogicalResourceId,
      awsRequestId: context.awsRequestId,
    });

    let status: ResponseStatus = 'SUCCESS';
    let reason = 'Migration request completed';
    try {
      if (event.RequestType === 'Delete') {
        reason = 'Delete is a no-op';
      } else {
        requiredEnvironment('ENVIRONMENT');
        const currentHash = bundleHash(event.ResourceProperties);
        const unchanged =
          event.RequestType === 'Update' &&
          bundleHash(event.OldResourceProperties) === currentHash;
        if (unchanged) {
          reason = 'Migration bundle is unchanged';
        } else {
          await runMigrations(MIGRATIONS_ROOT, () => context.getRemainingTimeInMillis());
        }
      }
    } catch (error) {
      status = 'FAILED';
      const code = errorCode(error);
      reason = `Migration failed (${code}); see CloudWatch Logs`;
      safeLog({
        event: 'migration_failed',
        requestType: event.RequestType,
        logicalResourceId: event.LogicalResourceId,
        awsRequestId: context.awsRequestId,
        errorCode: code,
      });
    }

    await responseSender(event, status, reason, physicalResourceId);
    safeLog({
      event: 'custom_resource_response_sent',
      requestType: event.RequestType,
      status,
      durationMs: Date.now() - startedAt,
      awsRequestId: context.awsRequestId,
    });
  };
}

export const handler = createHandler();
