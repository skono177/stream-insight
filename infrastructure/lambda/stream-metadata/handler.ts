import { Context } from 'aws-lambda';
import { DatabaseConfig, DatabaseSession } from './database';
import { StreamMetadataOutput } from './contracts';
import { StreamMetadataError } from './errors';
import { consoleLogger } from './logging';
import { executeOperation } from './operations';
import { validateInput } from './validation';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new StreamMetadataError('UNEXPECTED', `Required environment variable is missing: ${name}`);
  return value;
}

function databaseConfig(): DatabaseConfig {
  const portText = requiredEnvironment('DB_PORT');
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new StreamMetadataError('UNEXPECTED', 'DB_PORT is invalid');
  }
  return {
    host: requiredEnvironment('DB_HOST'),
    port,
    database: requiredEnvironment('DB_NAME'),
    user: requiredEnvironment('DB_USER'),
    region: requiredEnvironment('AWS_REGION'),
    caBundlePath: requiredEnvironment('RDS_CA_BUNDLE_PATH'),
  };
}

export async function handler(event: unknown, context: Context): Promise<StreamMetadataOutput> {
  const startedAt = Date.now();
  let session: DatabaseSession | undefined;
  let operation: string | undefined;
  let streamId: string | undefined;
  let collectionJobId: string | undefined;
  try {
    const input = validateInput(event);
    operation = input.operation;
    streamId = 'streamId' in input ? input.streamId : undefined;
    collectionJobId = 'collectionJobId' in input ? input.collectionJobId : undefined;
    session = await DatabaseSession.connect(databaseConfig(), context, consoleLogger);
    const output = await session.transaction((db) => executeOperation(db, input), context);
    consoleLogger.log({ event: 'operation_succeeded', awsRequestId: context.awsRequestId, operation,
      streamId: 'streamId' in output ? output.streamId : undefined,
      collectionJobId: 'collectionJobId' in output ? output.collectionJobId : undefined,
      elapsedMs: Date.now() - startedAt });
    return output;
  } catch (error) {
    const classified = error instanceof StreamMetadataError
      ? error
      : new StreamMetadataError('UNEXPECTED', 'Unexpected stream metadata failure', undefined, { cause: error });
    consoleLogger.log({ event: 'operation_failed', awsRequestId: context.awsRequestId, operation,
      streamId, collectionJobId, classification: classified.classification,
      postgresCode: classified.postgresCode, elapsedMs: Date.now() - startedAt });
    throw classified;
  } finally {
    await session?.close();
  }
}
