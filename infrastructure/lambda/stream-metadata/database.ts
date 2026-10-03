import { Signer } from '@aws-sdk/rds-signer';
import { Client, ClientConfig, types } from 'pg';
import { readFile } from 'node:fs/promises';
import { StreamMetadataError, classifyDatabaseError } from './errors';
import { SafeLogger } from './logging';
import { QueryResult, SqlExecutor } from './operations';

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly region: string;
  readonly caBundlePath: string;
}

export interface TimeBudget {
  getRemainingTimeInMillis(): number;
}

interface DatabaseClient extends SqlExecutor {
  connect(): Promise<unknown>;
  end(): Promise<void>;
}

export interface DatabaseDependencies {
  readonly createToken?: (config: DatabaseConfig) => Promise<string>;
  readonly createClient?: (config: ClientConfig) => DatabaseClient;
  readonly readCa?: (path: string) => Promise<string>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
  readonly setTimer?: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

const MIN_OPERATION_BUDGET_MS = 5_000;
const QUERY_TIMEOUT_MS = 10_000;
const ROLLBACK_TIMEOUT_MS = 3_000;
const CLOSE_TIMEOUT_MS = 1_000;
const CLEANUP_SAFETY_MS = 500;

interface TimerDependencies {
  readonly setTimer: (callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}

const defaultTimers: TimerDependencies = {
  setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimer: (timer) => clearTimeout(timer),
};

// Keep TIMESTAMPTZ values lossless; node-postgres' default Date parser truncates PostgreSQL microseconds.
types.setTypeParser(types.builtins.TIMESTAMPTZ, (value) => value);

function requireBudget(budget: TimeBudget, workTimeoutMs = QUERY_TIMEOUT_MS): void {
  if (budget.getRemainingTimeInMillis() <= MIN_OPERATION_BUDGET_MS + workTimeoutMs) {
    throw new StreamMetadataError('TIME_BUDGET', 'Insufficient Lambda time budget');
  }
}

function destroyConnection(client: DatabaseClient): void {
  const internal = client as unknown as { connection?: { stream?: { destroy(): void } } };
  internal.connection?.stream?.destroy();
}

async function boundedClose(client: DatabaseClient, timers: TimerDependencies): Promise<void> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejected = false;
  try {
    await Promise.race([
      client.end(),
      new Promise<void>((resolve) => {
        timer = timers.setTimer(() => { timedOut = true; resolve(); }, CLOSE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    rejected = true;
  } finally {
    if (timer !== undefined) timers.clearTimer(timer);
  }
  if (timedOut || rejected) destroyConnection(client);
}

function isPgConnectionTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'timeout expired' && !('code' in error);
}

function isDefinitiveCommitFailure(error: unknown): boolean {
  return error instanceof StreamMetadataError && (
    error.classification === 'DB_TRANSACTION_TRANSIENT' ||
    error.classification === 'DB_CONSTRAINT' ||
    error.classification === 'DB_AUTHORIZATION'
  );
}

export class DatabaseSession implements SqlExecutor {
  private constructor(
    private readonly client: DatabaseClient,
    private readonly budget: TimeBudget,
    private readonly logger: SafeLogger,
    private readonly timers: TimerDependencies,
  ) {}

  static async connect(
    config: DatabaseConfig,
    budget: TimeBudget,
    logger: SafeLogger,
    dependencies: DatabaseDependencies = {},
  ): Promise<DatabaseSession> {
    const createToken = dependencies.createToken ?? (async (value: DatabaseConfig) => new Signer({
      hostname: value.host,
      port: value.port,
      username: value.user,
      region: value.region,
    }).getAuthToken());
    const createClient = dependencies.createClient ?? ((value: ClientConfig) => new Client(value) as DatabaseClient);
    const readCa = dependencies.readCa ?? (async (path: string) => readFile(path, 'utf8'));
    const sleep = dependencies.sleep ?? (async (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const random = dependencies.random ?? Math.random;
    const timers: TimerDependencies = {
      setTimer: dependencies.setTimer ?? defaultTimers.setTimer,
      clearTimer: dependencies.clearTimer ?? defaultTimers.clearTimer,
    };
    requireBudget(budget);
    const ca = await readCa(config.caBundlePath);
    let lastError: StreamMetadataError | undefined;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      requireBudget(budget);
      let client: DatabaseClient | undefined;
      try {
        const password = await createToken(config);
        client = createClient({
          host: config.host,
          port: config.port,
          database: config.database,
          user: config.user,
          password,
          ssl: { ca, rejectUnauthorized: true },
          connectionTimeoutMillis: QUERY_TIMEOUT_MS,
          query_timeout: QUERY_TIMEOUT_MS,
          options: `-c statement_timeout=${QUERY_TIMEOUT_MS}`,
        });
        await client.connect();
        return new DatabaseSession(client, budget, logger, timers);
      } catch (error) {
        if (client) await boundedClose(client, timers);
        lastError = isPgConnectionTimeout(error)
          ? new StreamMetadataError('DB_CONNECTION_TRANSIENT', 'Database connection timed out', undefined, { cause: error })
          : classifyDatabaseError(error, 'connection');
        logger.log({ event: 'database_connect_failed', classification: lastError.classification,
          postgresCode: lastError.postgresCode, retryCount: attempt });
        if (lastError.classification !== 'DB_CONNECTION_TRANSIENT' || attempt === 2) throw lastError;
        const maximumDelay = attempt === 0 ? 1_000 : 2_000;
        const delay = Math.floor(random() * maximumDelay);
        requireBudget(budget, QUERY_TIMEOUT_MS + delay);
        await sleep(delay);
      }
    }
    throw lastError ?? new StreamMetadataError('UNEXPECTED', 'Database connection failed');
  }

  async query<T>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>> {
    requireBudget(this.budget);
    return this.rawQuery(text, values);
  }

  private async rawQuery<T>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>> {
    try {
      const result = await this.client.query<T>(text, values);
      return { rows: result.rows, rowCount: result.rowCount };
    } catch (error) {
      throw classifyDatabaseError(error, 'query');
    }
  }

  async transaction<T>(work: (db: SqlExecutor) => Promise<T>, budget: TimeBudget): Promise<T> {
    if (budget !== this.budget) throw new StreamMetadataError('UNEXPECTED', 'Time budget identity changed');
    await this.query('BEGIN');
    let commitStarted = false;
    try {
      const result = await work(this);
      requireBudget(budget);
      commitStarted = true;
      try {
        await this.rawQuery('COMMIT');
      } catch (error) {
        if (isDefinitiveCommitFailure(error)) throw error;
        destroyConnection(this.client);
        throw new StreamMetadataError('COMMIT_OUTCOME_UNKNOWN', 'Database commit outcome is unknown', undefined, { cause: error });
      }
      return result;
    } catch (error) {
      if (commitStarted) throw error;
      await this.boundedRollback();
      throw error;
    }
  }

  private async boundedRollback(): Promise<void> {
    const available = this.budget.getRemainingTimeInMillis() - CLOSE_TIMEOUT_MS - CLEANUP_SAFETY_MS;
    const timeout = Math.min(ROLLBACK_TIMEOUT_MS, Math.max(0, available));
    if (timeout === 0) {
      destroyConnection(this.client);
      this.logger.log({ event: 'database_rollback_failed', classification: 'TIME_BUDGET' });
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.rawQuery('ROLLBACK'),
        new Promise<void>((_, reject) => {
          timer = this.timers.setTimer(() => {
            reject(new StreamMetadataError('TIME_BUDGET', 'Database rollback timed out'));
          }, timeout);
        }),
      ]);
    } catch (rollbackError) {
      const classified = rollbackError instanceof StreamMetadataError
        ? rollbackError
        : classifyDatabaseError(rollbackError, 'query');
      this.logger.log({ event: 'database_rollback_failed', classification: classified.classification,
        postgresCode: classified.postgresCode });
      destroyConnection(this.client);
    } finally {
      if (timer !== undefined) this.timers.clearTimer(timer);
    }
  }

  async close(): Promise<void> {
    await boundedClose(this.client, this.timers);
  }
}
