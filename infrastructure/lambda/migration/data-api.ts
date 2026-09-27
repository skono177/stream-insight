import {
  BeginTransactionCommand,
  BeginTransactionCommandOutput,
  CommitTransactionCommand,
  ExecuteStatementCommand,
  ExecuteStatementCommandOutput,
  RDSDataClient,
  RollbackTransactionCommand,
  SqlParameter,
} from '@aws-sdk/client-rds-data';
import { MigrationError } from './migration-definition';

export const CLOUDFORMATION_RESPONSE_RESERVE_MS = 10_000;
export const DATA_API_REQUEST_TIMEOUT_MS = 30_000;

type DataApiCommand =
  | BeginTransactionCommand
  | ExecuteStatementCommand
  | CommitTransactionCommand
  | RollbackTransactionCommand;

interface RdsDataApiDependencies {
  readonly send?: (
    command: DataApiCommand,
    options: { readonly abortSignal: AbortSignal },
  ) => Promise<unknown>;
  readonly setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface DataApi {
  beginTransaction(): Promise<string>;
  executeOutsideTransaction(
    sql: string,
    parameters?: SqlParameter[],
    maximumDurationMs?: number,
  ): Promise<DataApiStatementResult>;
  executeInTransaction(
    transactionId: string,
    sql: string,
    parameters?: SqlParameter[],
  ): Promise<DataApiStatementResult>;
  commitTransaction(transactionId: string): Promise<void>;
  rollbackTransaction(transactionId: string): Promise<void>;
}

export type DataApiStatementResult = Pick<ExecuteStatementCommandOutput, 'records'>;

export interface RdsDataApiConfig {
  readonly resourceArn: string;
  readonly secretArn: string;
  readonly database: string;
  readonly remainingTime: () => number;
}

export class RdsDataApi implements DataApi {
  private readonly send: NonNullable<RdsDataApiDependencies['send']>;
  private readonly setTimer: NonNullable<RdsDataApiDependencies['setTimer']>;
  private readonly clearTimer: NonNullable<RdsDataApiDependencies['clearTimer']>;

  constructor(
    private readonly config: RdsDataApiConfig,
    dependencies: RdsDataApiDependencies = {},
  ) {
    const client = new RDSDataClient({ maxAttempts: 1 });
    const clientSend = client.send.bind(client) as unknown as NonNullable<
      RdsDataApiDependencies['send']
    >;
    this.send = dependencies.send ?? clientSend;
    this.setTimer = dependencies.setTimer ?? setTimeout;
    this.clearTimer = dependencies.clearTimer ?? clearTimeout;
  }

  async beginTransaction(): Promise<string> {
    const result = await this.sendWithTimeout(
      new BeginTransactionCommand(this.commonInput()),
    ) as BeginTransactionCommandOutput;
    if (!result.transactionId) {
      throw new MigrationError('DATA_API', 'BeginTransaction returned no transaction ID');
    }
    return result.transactionId;
  }

  executeOutsideTransaction(
    sql: string,
    parameters?: SqlParameter[],
    maximumDurationMs?: number,
  ): Promise<DataApiStatementResult> {
    return this.sendWithTimeout(
      new ExecuteStatementCommand({
        ...this.commonInput(),
        sql,
        parameters,
        continueAfterTimeout: false,
      }),
      maximumDurationMs,
    ) as Promise<DataApiStatementResult>;
  }

  executeInTransaction(
    transactionId: string,
    sql: string,
    parameters?: SqlParameter[],
  ): Promise<DataApiStatementResult> {
    return this.sendWithTimeout(
      new ExecuteStatementCommand({
        ...this.commonInput(),
        transactionId,
        sql,
        parameters,
        continueAfterTimeout: false,
      }),
    ) as Promise<DataApiStatementResult>;
  }

  async commitTransaction(transactionId: string): Promise<void> {
    await this.sendWithTimeout(
      new CommitTransactionCommand({ ...this.commonInput(), transactionId }),
    );
  }

  async rollbackTransaction(transactionId: string): Promise<void> {
    await this.sendWithTimeout(
      new RollbackTransactionCommand({ ...this.commonInput(), transactionId }),
    );
  }

  private commonInput(): Omit<RdsDataApiConfig, 'remainingTime'> {
    const { remainingTime: _remainingTime, ...input } = this.config;
    return input;
  }

  private async sendWithTimeout(
    command: DataApiCommand,
    maximumDurationMs = DATA_API_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const available = this.config.remainingTime() - CLOUDFORMATION_RESPONSE_RESERVE_MS;
    if (available <= 0) {
      throw new MigrationError('TIME_BUDGET', 'Insufficient time for Data API request');
    }

    const controller = new AbortController();
    const timeout = Math.min(DATA_API_REQUEST_TIMEOUT_MS, available, maximumDurationMs);
    if (timeout <= 0) {
      throw new MigrationError('TIME_BUDGET', 'Insufficient time for Data API request');
    }
    const timer = this.setTimer(() => controller.abort(), timeout);
    try {
      return await this.send(command, { abortSignal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new MigrationError('TIME_BUDGET', 'Data API request timed out');
      }
      throw error;
    } finally {
      this.clearTimer(timer);
    }
  }
}
