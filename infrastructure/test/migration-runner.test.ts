import assert from 'node:assert/strict';
import { SqlParameter } from '@aws-sdk/client-rds-data';
import test from 'node:test';
import { DataApi, DataApiStatementResult } from '../lambda/migration/data-api';
import { MigrationDefinition, MigrationError } from '../lambda/migration/migration-definition';
import { MigrationRunner } from '../lambda/migration/migration-runner';

const migration: MigrationDefinition = {
  version: 1,
  name: 'initial_schema',
  directoryName: '001_initial_schema',
  checksum: 'a'.repeat(64),
  sqlFiles: [
    {
      sequence: 1,
      fileName: '001_a.sql',
      relativePath: '001_initial_schema/001_a.sql',
      sql: 'CREATE TABLE a (id INTEGER)',
      bytes: Buffer.from('CREATE TABLE a (id INTEGER)'),
    },
    {
      sequence: 2,
      fileName: '002_b.sql',
      relativePath: '001_initial_schema/002_b.sql',
      sql: 'CREATE TABLE b (id INTEGER)',
      bytes: Buffer.from('CREATE TABLE b (id INTEGER)'),
    },
  ],
};

function schemaColumns(): DataApiStatementResult {
  const row = (...values: Array<string | number | undefined>) =>
    values.map((value) =>
      value === undefined
        ? { isNull: true }
        : typeof value === 'number'
          ? { longValue: value }
          : { stringValue: value },
    );
  return {
    records: [
      row('version', 'integer', 'int4', 'NO', undefined, undefined),
      row('name', 'text', 'text', 'NO', undefined, undefined),
      row('checksum', 'character', 'bpchar', 'NO', undefined, 64),
      row('applied_at', 'timestamp with time zone', 'timestamptz', 'NO', 'CURRENT_TIMESTAMP', undefined),
    ],
  };
}

function schemaConstraints(): DataApiStatementResult {
  return {
    records: [
      [
        { stringValue: 'ck_schema_migrations_checksum' },
        { stringValue: 'c' },
        { stringValue: "CHECK ((checksum ~ '^[0-9a-f]{64}$'::text))" },
      ],
      [
        { stringValue: 'ck_schema_migrations_version' },
        { stringValue: 'c' },
        { stringValue: 'CHECK ((version > 0))' },
      ],
      [
        { stringValue: 'pk_schema_migrations' },
        { stringValue: 'p' },
        { stringValue: 'PRIMARY KEY (version)' },
      ],
    ],
  };
}

class FakeDataApi implements DataApi {
  readonly calls: string[] = [];
  preflightFailures = 0;
  preflightFailureName = 'DatabaseResumingException';
  preflightHook?: () => void;
  readonly preflightTimeouts: Array<number | undefined> = [];
  schemaColumnsResult: DataApiStatementResult = schemaColumns();
  schemaConstraintsResult: DataApiStatementResult = schemaConstraints();
  applied?: { name: string; checksum: string };
  concurrentApplied?: { name: string; checksum: string };
  lockResults: boolean[] = [true];
  failSql?: string;
  commitFailure?: Error;
  rollbackFailure?: Error;
  commits = 0;
  commitAttempts = 0;
  rollbacks = 0;
  begins = 0;

  async beginTransaction(): Promise<string> {
    this.begins += 1;
    this.calls.push('begin');
    return `transaction-${this.begins}`;
  }

  async executeOutsideTransaction(
    sql: string,
    _parameters?: SqlParameter[],
    maximumDurationMs?: number,
  ): Promise<DataApiStatementResult> {
    this.calls.push(`outside:${sql.split('\n')[0]}`);
    if (sql === 'SELECT 1') {
      this.preflightTimeouts.push(maximumDurationMs);
      this.preflightHook?.();
      if (this.preflightFailures > 0) {
        this.preflightFailures -= 1;
        const error = new Error('resuming');
        error.name = this.preflightFailureName;
        throw error;
      }
      return {};
    }
    if (sql.includes('information_schema.columns')) return this.schemaColumnsResult;
    if (sql.includes('FROM pg_constraint')) return this.schemaConstraintsResult;
    if (sql.startsWith('SELECT version')) {
      return this.applied
        ? {
            records: [[
              { longValue: 1 },
              { stringValue: this.applied.name },
              { stringValue: this.applied.checksum },
            ]],
          }
        : { records: [] };
    }
    return {};
  }

  async executeInTransaction(
    _transactionId: string,
    sql: string,
    _parameters?: SqlParameter[],
  ): Promise<DataApiStatementResult> {
    this.calls.push(`transaction:${sql.split('\n')[0]}`);
    if (sql.includes('pg_try_advisory_xact_lock')) {
      return { records: [[{ booleanValue: this.lockResults.shift() ?? true }]] };
    }
    if (sql.startsWith('SELECT name')) {
      return this.concurrentApplied
        ? {
            records: [[
              { stringValue: this.concurrentApplied.name },
              { stringValue: this.concurrentApplied.checksum },
            ]],
          }
        : { records: [] };
    }
    if (this.failSql && sql.includes(this.failSql)) throw new Error('statement failed');
    return {};
  }

  async commitTransaction(): Promise<void> {
    this.commitAttempts += 1;
    this.calls.push('commit');
    if (this.commitFailure) throw this.commitFailure;
    this.commits += 1;
  }

  async rollbackTransaction(): Promise<void> {
    this.calls.push('rollback');
    this.rollbacks += 1;
    if (this.rollbackFailure) throw this.rollbackFailure;
  }
}

interface RunnerOverrides {
  readonly remaining?: number;
  readonly remainingValues?: number[];
  readonly logs?: Record<string, unknown>[];
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
}

function runner(api: FakeDataApi, overrides: RunnerOverrides = {}) {
  const remainingValues = [...(overrides.remainingValues ?? [])];
  return new MigrationRunner(api, {
    sleep: overrides.sleep ?? (async () => undefined),
    random: overrides.random ?? (() => 0),
    remainingTime: () => remainingValues.shift() ?? overrides.remaining ?? 300_000,
    now: overrides.now,
    log: (entry) => overrides.logs?.push(entry),
  });
}

test('preflight succeeds, SQL runs in order, history is inserted, and transaction commits', async () => {
  const api = new FakeDataApi();
  await runner(api).run([migration]);
  const transactionCalls = api.calls.filter((call) => call.startsWith('transaction:'));
  assert.match(transactionCalls[0], /pg_try_advisory/);
  assert.match(transactionCalls[1], /SELECT name/);
  assert.match(transactionCalls[2], /CREATE TABLE a/);
  assert.match(transactionCalls[3], /CREATE TABLE b/);
  assert.match(transactionCalls[4], /INSERT INTO schema_migrations/);
  assert.equal(api.commits, 1);
});

test('retries only DatabaseResumingException during preflight', async () => {
  const api = new FakeDataApi();
  api.preflightFailures = 2;
  await runner(api).run([]);
  assert.equal(api.calls.filter((call) => call === 'outside:SELECT 1').length, 3);
});

test('preflight counts Data API execution time against its wall-clock deadline', async () => {
  const api = new FakeDataApi();
  let now = 0;
  let sleeps = 0;
  api.preflightFailures = 8;
  api.preflightHook = () => {
    now += 20_000;
  };
  await assert.rejects(
    runner(api, {
      now: () => now,
      sleep: async () => {
        sleeps += 1;
      },
    }).run([]),
    (error: unknown) => error instanceof MigrationError && error.code === 'DATA_API',
  );
  assert.equal(api.calls.filter((call) => call === 'outside:SELECT 1').length, 3);
  assert.equal(sleeps, 2);
  assert.deepEqual(api.preflightTimeouts, [60_000, 40_000, 20_000]);
});

test('preflight does not start another attempt when actual sleep passes the deadline', async () => {
  const api = new FakeDataApi();
  let now = 0;
  let sleeps = 0;
  api.preflightFailures = 8;
  await assert.rejects(
    runner(api, {
      now: () => now,
      random: () => 0.5,
      sleep: async () => {
        sleeps += 1;
        now += 60_000;
      },
    }).run([]),
    MigrationError,
  );
  assert.equal(api.calls.filter((call) => call === 'outside:SELECT 1').length, 1);
  assert.equal(sleeps, 1);
});

test('preflight does not sleep when delay plus next request window exceeds deadline', async () => {
  const api = new FakeDataApi();
  let now = 0;
  let sleeps = 0;
  api.preflightFailures = 1;
  api.preflightHook = () => {
    now = 59_000;
  };
  await assert.rejects(
    runner(api, {
      now: () => now,
      random: () => 0.5,
      sleep: async () => {
        sleeps += 1;
      },
    }).run([]),
    MigrationError,
  );
  assert.equal(sleeps, 0);
});

test('preflight is limited to eight attempts with exponential full-jitter cap', async () => {
  const api = new FakeDataApi();
  let now = 0;
  const delays: number[] = [];
  api.preflightFailures = 8;
  await assert.rejects(
    runner(api, {
      now: () => now,
      random: () => 0.999_999,
      sleep: async (delay) => {
        delays.push(delay);
        now += delay;
      },
    }).run([]),
    MigrationError,
  );
  assert.equal(api.calls.filter((call) => call === 'outside:SELECT 1').length, 8);
  assert.equal(delays.length, 7);
  assert.ok(delays.every((delay) => delay < 10_000));
  assert.deepEqual(delays.slice(0, 4), [999, 1_999, 3_999, 7_999]);
});

test('preflight does not retry errors other than DatabaseResumingException', async () => {
  const api = new FakeDataApi();
  api.preflightFailures = 1;
  api.preflightFailureName = 'AccessDeniedException';
  await assert.rejects(runner(api).run([]), MigrationError);
  assert.equal(api.calls.filter((call) => call === 'outside:SELECT 1').length, 1);
});

test('skips an applied migration when name and checksum match', async () => {
  const api = new FakeDataApi();
  api.applied = { name: migration.name, checksum: migration.checksum };
  await runner(api).run([migration]);
  assert.equal(api.begins, 0);
});

test('fails when an applied checksum differs', async () => {
  const api = new FakeDataApi();
  api.applied = { name: migration.name, checksum: 'b'.repeat(64) };
  await assert.rejects(runner(api).run([migration]), (error: unknown) =>
    error instanceof MigrationError && error.code === 'CHECKSUM_MISMATCH');
});

test('rolls back lock contention and retries with a new transaction', async () => {
  const api = new FakeDataApi();
  api.lockResults = [false, true];
  await runner(api).run([migration]);
  assert.equal(api.begins, 2);
  assert.equal(api.rollbacks, 1);
  assert.equal(api.commits, 1);
});

test('fails after bounded advisory lock attempts', async () => {
  const api = new FakeDataApi();
  api.lockResults = [false, false, false, false, false];
  await assert.rejects(runner(api).run([migration]), (error: unknown) =>
    error instanceof MigrationError && error.code === 'LOCK_TIMEOUT');
  assert.equal(api.begins, 5);
  assert.equal(api.rollbacks, 5);
});

test('rolls back and does not retry a failed SQL statement', async () => {
  const api = new FakeDataApi();
  api.failSql = 'CREATE TABLE b';
  await assert.rejects(runner(api).run([migration]), MigrationError);
  assert.equal(api.rollbacks, 1);
  assert.equal(api.begins, 1);
});

test('treats commit failure as indeterminate and does not roll back', async () => {
  const api = new FakeDataApi();
  api.commitFailure = new Error('network timeout');
  await assert.rejects(runner(api).run([migration]), (error: unknown) =>
    error instanceof MigrationError && error.code === 'TRANSACTION_INDETERMINATE');
  assert.equal(api.rollbacks, 0);
  assert.equal(api.commitAttempts, 1);
});

test('treats an aborted commit as indeterminate without retry or rollback', async () => {
  const api = new FakeDataApi();
  api.commitFailure = new MigrationError('TIME_BUDGET', 'Data API request timed out');
  await assert.rejects(runner(api).run([migration]), (error: unknown) =>
    error instanceof MigrationError && error.code === 'TRANSACTION_INDETERMINATE');
  assert.equal(api.commitAttempts, 1);
  assert.equal(api.rollbacks, 0);
});

test('preserves the migration failure when rollback also fails', async () => {
  const api = new FakeDataApi();
  const logs: Record<string, unknown>[] = [];
  api.failSql = 'CREATE TABLE a';
  api.rollbackFailure = new Error('rollback failed');
  await assert.rejects(runner(api, { logs }).run([migration]), MigrationError);
  assert.ok(logs.some((entry) => entry.event === 'rollback_failed'));
});

test('checks remaining time before bootstrap', async () => {
  const api = new FakeDataApi();
  await assert.rejects(runner(api, { remainingValues: [300_000, 59_999] }).run([migration]), (error: unknown) =>
    error instanceof MigrationError && error.code === 'TIME_BUDGET');
  assert.equal(api.begins, 0);
});

test('checks remaining time before a new version', async () => {
  const api = new FakeDataApi();
  await assert.rejects(
    runner(api, { remainingValues: [300_000, 300_000, 59_999] }).run([migration]),
    (error: unknown) => error instanceof MigrationError && error.code === 'TIME_BUDGET',
  );
  assert.equal(api.begins, 0);
});

for (const boundary of [
  { name: 'SQL statement', values: [300_000, 300_000, 300_000, 300_000, 19_999], commits: 0 },
  { name: 'history insert', values: [300_000, 300_000, 300_000, 300_000, 300_000, 300_000, 19_999], commits: 0 },
  { name: 'commit', values: [300_000, 300_000, 300_000, 300_000, 300_000, 300_000, 300_000, 19_999], commits: 0 },
]) {
  test(`checks remaining time before ${boundary.name}`, async () => {
    const api = new FakeDataApi();
    await assert.rejects(
      runner(api, { remainingValues: boundary.values }).run([migration]),
      (error: unknown) => error instanceof MigrationError && error.code === 'TIME_BUDGET',
    );
    assert.equal(api.commitAttempts, boundary.commits);
    assert.equal(api.rollbacks, 1);
  });
}

test('detects schema_migrations column and CHAR length drift', async () => {
  for (const replacement of [
    { row: 1, column: 1, value: { stringValue: 'varchar' } },
    { row: 2, column: 5, value: { longValue: 63 } },
  ]) {
    const api = new FakeDataApi();
    const records = structuredClone(schemaColumns().records ?? []);
    records[replacement.row][replacement.column] = replacement.value;
    api.schemaColumnsResult = { records };
    await assert.rejects(runner(api).run([]), (error: unknown) =>
      error instanceof MigrationError && error.code === 'CONFIGURATION');
  }
});

test('detects schema_migrations primary key and CHECK drift', async () => {
  for (const replacement of [
    { row: 2, value: 'PRIMARY KEY (name)' },
    { row: 1, value: 'CHECK ((version >= 0))' },
  ]) {
    const api = new FakeDataApi();
    const records = structuredClone(schemaConstraints().records ?? []);
    records[replacement.row][2] = { stringValue: replacement.value };
    api.schemaConstraintsResult = { records };
    await assert.rejects(runner(api).run([]), (error: unknown) =>
      error instanceof MigrationError && error.code === 'CONFIGURATION');
  }
});
