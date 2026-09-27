import { Field, SqlParameter } from '@aws-sdk/client-rds-data';
import { DataApi, DataApiStatementResult } from './data-api';
import { MigrationDefinition, MigrationError } from './migration-definition';

const BOOTSTRAP_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  checksum CHAR(64) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT pk_schema_migrations PRIMARY KEY (version),
  CONSTRAINT ck_schema_migrations_version CHECK (version > 0),
  CONSTRAINT ck_schema_migrations_checksum CHECK (checksum ~ '^[0-9a-f]{64}$')
)`;

const SCHEMA_COLUMNS_SQL = `SELECT
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default,
  character_maximum_length
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND table_name = 'schema_migrations'
ORDER BY ordinal_position`;

const SCHEMA_CONSTRAINTS_SQL = `SELECT
  conname,
  contype,
  pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'schema_migrations'::regclass
ORDER BY conname`;

const APPLIED_MIGRATIONS_SQL =
  'SELECT version, name, checksum FROM schema_migrations ORDER BY version';
const VERSION_HISTORY_SQL =
  'SELECT name, checksum FROM schema_migrations WHERE version = :version';
const INSERT_HISTORY_SQL = `INSERT INTO schema_migrations (version, name, checksum)
VALUES (:version, :name, :checksum)`;
const ADVISORY_LOCK_SQL = `SELECT pg_try_advisory_xact_lock(
  760466283874603037::bigint
) AS acquired`;

const PREFLIGHT_MAX_ATTEMPTS = 8;
const PREFLIGHT_WALL_CLOCK_LIMIT_MS = 60_000;
const PREFLIGHT_MIN_REQUEST_WINDOW_MS = 1_000;
const MIN_RETRY_REMAINING_MS = 30_000;
const MIN_VERSION_REMAINING_MS = 60_000;
const MIN_TRANSACTION_STEP_REMAINING_MS = 20_000;
const LOCK_MAX_ATTEMPTS = 5;

interface AppliedMigration {
  readonly name: string;
  readonly checksum: string;
}

export interface MigrationRunnerDependencies {
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
  readonly remainingTime?: () => number;
  readonly now?: () => number;
  readonly log?: (entry: Record<string, unknown>) => void;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String(error.name)
    : 'UnknownError';
}

function stringField(field: Field | undefined, label: string): string {
  if (typeof field?.stringValue !== 'string') {
    throw new MigrationError('DATA_API', `Data API returned an invalid ${label}`);
  }
  return field.stringValue;
}

function integerField(field: Field | undefined, label: string): number {
  if (typeof field?.longValue !== 'number' || !Number.isSafeInteger(field.longValue)) {
    throw new MigrationError('DATA_API', `Data API returned an invalid ${label}`);
  }
  return field.longValue;
}

function nullableStringField(field: Field | undefined): string | undefined {
  if (field?.isNull === true) {
    return undefined;
  }
  return field?.stringValue;
}

function nullableIntegerField(field: Field | undefined): number | undefined {
  if (field?.isNull === true) {
    return undefined;
  }
  return field?.longValue;
}

function versionParameter(version: number): SqlParameter {
  return { name: 'version', value: { longValue: version } };
}

export class MigrationRunner {
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly remainingTime: () => number;
  private readonly now: () => number;
  private readonly log: (entry: Record<string, unknown>) => void;

  constructor(
    private readonly dataApi: DataApi,
    dependencies: MigrationRunnerDependencies = {},
  ) {
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.random = dependencies.random ?? Math.random;
    this.remainingTime = dependencies.remainingTime ?? (() => Number.POSITIVE_INFINITY);
    this.now = dependencies.now ?? Date.now;
    this.log = dependencies.log ?? ((entry) => console.log(JSON.stringify(entry)));
  }

  async run(migrations: readonly MigrationDefinition[]): Promise<void> {
    const startedAt = Date.now();
    this.log({ event: 'migration_start', migrationCount: migrations.length });
    await this.preflight();
    this.ensureRemaining(MIN_VERSION_REMAINING_MS, 'schema_migrations bootstrap');
    await this.bootstrapSchemaMigrations();
    const applied = await this.loadAppliedMigrations();

    for (const migration of migrations) {
      const existing = applied.get(migration.version);
      if (existing) {
        this.assertHistoryMatches(migration, existing);
        this.log({
          event: 'migration_skip',
          version: migration.version,
          migrationName: migration.name,
          checksum: migration.checksum,
        });
        continue;
      }

      this.ensureRemaining(MIN_VERSION_REMAINING_MS, 'new version');
      await this.applyVersion(migration);
    }

    this.log({ event: 'migration_complete', durationMs: Date.now() - startedAt });
  }

  private async preflight(): Promise<void> {
    const deadline = this.now() + PREFLIGHT_WALL_CLOCK_LIMIT_MS;
    for (let attempt = 1; attempt <= PREFLIGHT_MAX_ATTEMPTS; attempt += 1) {
      this.ensurePreflightDeadline(deadline, PREFLIGHT_MIN_REQUEST_WINDOW_MS);
      this.ensureRemaining(MIN_RETRY_REMAINING_MS, 'auto-pause attempt');
      try {
        await this.dataApi.executeOutsideTransaction(
          'SELECT 1',
          undefined,
          deadline - this.now(),
        );
        this.log({ event: 'preflight_complete', attempt });
        return;
      } catch (error) {
        if (error instanceof MigrationError) {
          throw error;
        }
        if (errorName(error) !== 'DatabaseResumingException' || attempt === PREFLIGHT_MAX_ATTEMPTS) {
          throw new MigrationError('DATA_API', 'Data API preflight failed', { cause: error });
        }
        const maximumDelay = Math.min(1_000 * 2 ** (attempt - 1), 10_000);
        const delay = Math.floor(this.random() * maximumDelay);
        this.ensurePreflightDeadline(deadline, delay + PREFLIGHT_MIN_REQUEST_WINDOW_MS, error);
        this.ensureRemaining(MIN_RETRY_REMAINING_MS + delay, 'auto-pause retry');
        this.log({ event: 'preflight_retry', attempt, delayMs: delay });
        await this.sleep(delay);
      }
    }
  }

  private async bootstrapSchemaMigrations(): Promise<void> {
    await this.dataApi.executeOutsideTransaction(BOOTSTRAP_SQL);
    const [columns, constraints] = await Promise.all([
      this.dataApi.executeOutsideTransaction(SCHEMA_COLUMNS_SQL),
      this.dataApi.executeOutsideTransaction(SCHEMA_CONSTRAINTS_SQL),
    ]);
    this.validateSchemaColumns(columns);
    this.validateSchemaConstraints(constraints);
    this.log({ event: 'schema_migrations_validated' });
  }

  private validateSchemaColumns(result: DataApiStatementResult): void {
    const rows = result.records ?? [];
    const expected = [
      ['version', 'integer', 'int4', 'NO', undefined, undefined],
      ['name', 'text', 'text', 'NO', undefined, undefined],
      ['checksum', 'character', 'bpchar', 'NO', undefined, 64],
      ['applied_at', 'timestamp with time zone', 'timestamptz', 'NO', 'CURRENT_TIMESTAMP', undefined],
    ] as const;
    if (rows.length !== expected.length) {
      throw new MigrationError('CONFIGURATION', 'schema_migrations has unexpected columns');
    }
    rows.forEach((row, index) => {
      const actual = [
        stringField(row[0], 'column name'),
        stringField(row[1], 'column type'),
        stringField(row[2], 'column UDT'),
        stringField(row[3], 'column nullability'),
        nullableStringField(row[4]),
        nullableIntegerField(row[5]),
      ] as const;
      if (actual.some((value, itemIndex) => value !== expected[index][itemIndex])) {
        throw new MigrationError('CONFIGURATION', 'schema_migrations column definition differs');
      }
    });
  }

  private validateSchemaConstraints(result: DataApiStatementResult): void {
    const constraints = new Map(
      (result.records ?? []).map((row) => [
        stringField(row[0], 'constraint name'),
        {
          type: stringField(row[1], 'constraint type'),
          definition: stringField(row[2], 'constraint definition'),
        },
      ]),
    );
    if (constraints.size !== 3) {
      throw new MigrationError('CONFIGURATION', 'schema_migrations has unexpected constraints');
    }
    const primaryKey = constraints.get('pk_schema_migrations');
    const versionCheck = constraints.get('ck_schema_migrations_version');
    const checksumCheck = constraints.get('ck_schema_migrations_checksum');
    const compact = (value: string) => value.replace(/\s+/g, '').toLowerCase();
    const canonicalCheck = (value: string) =>
      compact(value).split('::text').join('').replace(/[()]/g, '');
    if (
      primaryKey?.type !== 'p' ||
      compact(primaryKey.definition) !== 'primarykey(version)' ||
      versionCheck?.type !== 'c' ||
      canonicalCheck(versionCheck.definition) !== 'checkversion>0' ||
      checksumCheck?.type !== 'c' ||
      canonicalCheck(checksumCheck.definition) !== "checkchecksum~'^[0-9a-f]{64}$'"
    ) {
      throw new MigrationError('CONFIGURATION', 'schema_migrations constraint definition differs');
    }
  }

  private async loadAppliedMigrations(): Promise<Map<number, AppliedMigration>> {
    const result = await this.dataApi.executeOutsideTransaction(APPLIED_MIGRATIONS_SQL);
    return new Map(
      (result.records ?? []).map((row) => [
        integerField(row[0], 'migration version'),
        {
          name: stringField(row[1], 'migration name'),
          checksum: stringField(row[2], 'migration checksum'),
        },
      ]),
    );
  }

  private assertHistoryMatches(
    migration: MigrationDefinition,
    applied: AppliedMigration,
  ): void {
    if (applied.name !== migration.name || applied.checksum !== migration.checksum) {
      throw new MigrationError(
        'CHECKSUM_MISMATCH',
        `Applied migration metadata differs for version ${migration.version}`,
      );
    }
  }

  private async applyVersion(migration: MigrationDefinition): Promise<void> {
    for (let lockAttempt = 1; lockAttempt <= LOCK_MAX_ATTEMPTS; lockAttempt += 1) {
      this.ensureRemaining(MIN_RETRY_REMAINING_MS, 'advisory lock attempt');
      const transactionId = await this.dataApi.beginTransaction();
      let commitStarted = false;
      let rollbackAttempted = false;
      try {
        const lockResult = await this.dataApi.executeInTransaction(
          transactionId,
          ADVISORY_LOCK_SQL,
        );
        const acquired = lockResult.records?.[0]?.[0]?.booleanValue;
        if (typeof acquired !== 'boolean') {
          throw new MigrationError('DATA_API', 'Advisory lock result is missing');
        }
        if (!acquired) {
          rollbackAttempted = true;
          await this.dataApi.rollbackTransaction(transactionId);
          if (lockAttempt === LOCK_MAX_ATTEMPTS) {
            throw new MigrationError('LOCK_TIMEOUT', 'Migration advisory lock was not acquired');
          }
          const maximumDelay = Math.min(250 * 2 ** (lockAttempt - 1), 2_000);
          const delay = Math.floor(this.random() * maximumDelay);
          this.ensureRemaining(MIN_RETRY_REMAINING_MS + delay, 'advisory lock retry');
          this.log({ event: 'advisory_lock_retry', attempt: lockAttempt, delayMs: delay });
          await this.sleep(delay);
          continue;
        }

        const history = await this.dataApi.executeInTransaction(
          transactionId,
          VERSION_HISTORY_SQL,
          [versionParameter(migration.version)],
        );
        const row = history.records?.[0];
        if (row) {
          this.assertHistoryMatches(migration, {
            name: stringField(row[0], 'migration name'),
            checksum: stringField(row[1], 'migration checksum'),
          });
          rollbackAttempted = true;
          await this.dataApi.rollbackTransaction(transactionId);
          return;
        }

        this.log({
          event: 'version_start',
          version: migration.version,
          migrationName: migration.name,
          checksum: migration.checksum,
        });
        for (const file of migration.sqlFiles) {
          this.ensureRemaining(MIN_TRANSACTION_STEP_REMAINING_MS, 'SQL statement');
          this.log({
            event: 'sql_start',
            version: migration.version,
            sqlFile: file.relativePath,
          });
          await this.dataApi.executeInTransaction(transactionId, file.sql);
        }
        this.ensureRemaining(MIN_TRANSACTION_STEP_REMAINING_MS, 'migration history insert');
        await this.dataApi.executeInTransaction(transactionId, INSERT_HISTORY_SQL, [
          versionParameter(migration.version),
          { name: 'name', value: { stringValue: migration.name } },
          { name: 'checksum', value: { stringValue: migration.checksum } },
        ]);
        this.ensureRemaining(MIN_TRANSACTION_STEP_REMAINING_MS, 'commit');
        commitStarted = true;
        await this.dataApi.commitTransaction(transactionId);
        this.log({
          event: 'version_complete',
          version: migration.version,
          migrationName: migration.name,
        });
        return;
      } catch (error) {
        if (commitStarted) {
          throw new MigrationError(
            'TRANSACTION_INDETERMINATE',
            `Commit result is indeterminate for version ${migration.version}`,
            { cause: error },
          );
        }
        if (!rollbackAttempted) {
          try {
            rollbackAttempted = true;
            await this.dataApi.rollbackTransaction(transactionId);
            this.log({ event: 'rollback_complete', version: migration.version });
          } catch (rollbackError) {
            this.log({
              event: 'rollback_failed',
              version: migration.version,
              errorName: errorName(rollbackError),
            });
          }
        }
        if (error instanceof MigrationError) {
          throw error;
        }
        throw new MigrationError('DATA_API', `Migration failed for version ${migration.version}`, {
          cause: error,
        });
      }
    }
  }

  private ensureRemaining(minimumMilliseconds: number, stage: string): void {
    if (this.remainingTime() < minimumMilliseconds) {
      throw new MigrationError('TIME_BUDGET', `Insufficient remaining time before ${stage}`);
    }
  }

  private ensurePreflightDeadline(
    deadline: number,
    requiredMilliseconds: number,
    cause?: unknown,
  ): void {
    if (deadline - this.now() < requiredMilliseconds) {
      throw new MigrationError('DATA_API', 'Auto-pause retry wall-clock limit exceeded', {
        cause,
      });
    }
  }
}
