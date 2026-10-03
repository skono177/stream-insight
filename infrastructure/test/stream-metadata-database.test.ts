import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientConfig } from 'pg';
import { DatabaseSession } from '../lambda/stream-metadata/database';
import { StreamMetadataError } from '../lambda/stream-metadata/errors';
import { SafeLogger } from '../lambda/stream-metadata/logging';
import { QueryResult } from '../lambda/stream-metadata/operations';

const config = { host: 'db.example', port: 5432, database: 'stream_insight', user: 'stream_metadata_user',
  region: 'ap-northeast-1', caBundlePath: '/ca.pem' };
const budget = { getRemainingTimeInMillis: () => 60_000 };
const logger: SafeLogger = { log: () => undefined };

class FakeClient {
  readonly queries: string[] = [];
  destroyCount = 0;
  readonly connection = { stream: { destroy: () => { this.destroyCount += 1; } } };
  constructor(
    private readonly connectError?: unknown,
    private readonly queryFailure?: (sql: string) => unknown,
    private readonly endResult: 'success' | 'reject' | 'hang' = 'success',
  ) {}
  async connect(): Promise<void> { if (this.connectError) throw this.connectError; }
  async end(): Promise<void> {
    if (this.endResult === 'reject') throw new Error('close failed');
    if (this.endResult === 'hang') return new Promise<void>(() => undefined);
  }
  async query<T>(text: string): Promise<QueryResult<T>> {
    this.queries.push(text);
    const failure = this.queryFailure?.(text);
    if (failure instanceof Promise) return failure as Promise<QueryResult<T>>;
    if (failure) throw failure;
    return { rows: [], rowCount: 0 };
  }
}

class ControlledTimers {
  readonly pending = new Map<ReturnType<typeof setTimeout>, () => void>();
  readonly durations: number[] = [];
  clearCount = 0;
  readonly setTimer = (callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> => {
    const timer = {} as ReturnType<typeof setTimeout>;
    this.durations.push(milliseconds);
    this.pending.set(timer, callback);
    return timer;
  };
  readonly clearTimer = (timer: ReturnType<typeof setTimeout>): void => {
    this.clearCount += 1;
    this.pending.delete(timer);
  };
  fireNext(): void {
    const entry = this.pending.entries().next().value as [ReturnType<typeof setTimeout>, () => void] | undefined;
    assert.ok(entry);
    this.pending.delete(entry[0]);
    entry[1]();
  }
}

test('connection retry uses a fresh IAM token, TLS verification and full-jitter backoff', async () => {
  const tokens: string[] = [];
  const clientConfigs: ClientConfig[] = [];
  const clients = [new FakeClient({ code: 'ECONNRESET' }), new FakeClient()];
  const delays: number[] = [];
  const session = await DatabaseSession.connect(config, budget, logger, {
    readCa: async () => 'CA',
    createToken: async () => { const token = `token-${tokens.length + 1}`; tokens.push(token); return token; },
    createClient: (value) => { clientConfigs.push(value); return clients.shift()!; },
    sleep: async (milliseconds) => { delays.push(milliseconds); },
    random: () => 0.5,
  });
  await session.close();
  assert.deepEqual(tokens, ['token-1', 'token-2']);
  assert.deepEqual(delays, [500]);
  assert.deepEqual(clientConfigs[1].ssl, { ca: 'CA', rejectUnauthorized: true });
  assert.equal(clientConfigs[1].query_timeout, 10_000);
});

test('PostgreSQL authentication failures are classified from SQLSTATE and are not retried', async () => {
  let attempts = 0;
  await assert.rejects(DatabaseSession.connect(config, budget, logger, {
    readCa: async () => 'CA', createToken: async () => 'token',
    createClient: () => { attempts += 1; return new FakeClient({ code: '28P01' }); },
    sleep: async () => undefined,
  }), (error: unknown) => error instanceof StreamMetadataError && error.classification === 'DB_AUTHENTICATION');
  assert.equal(attempts, 1);
});

test('transient connection attempts are capped at three', async () => {
  let attempts = 0;
  await assert.rejects(DatabaseSession.connect(config, budget, logger, {
    readCa: async () => 'CA', createToken: async () => `token-${attempts + 1}`,
    createClient: () => { attempts += 1; return new FakeClient({ code: '08006' }); },
    sleep: async () => undefined, random: () => 0,
  }), (error: unknown) => error instanceof StreamMetadataError && error.classification === 'DB_CONNECTION_TRANSIENT');
  assert.equal(attempts, 3);
});

test('pg connection timeout without a code is transient, retries three times and regenerates tokens', async () => {
  let attempts = 0;
  let tokens = 0;
  const delays: number[] = [];
  const clients: FakeClient[] = [];
  await assert.rejects(DatabaseSession.connect(config, budget, logger, {
    readCa: async () => 'CA',
    createToken: async () => { tokens += 1; return `token-${tokens}`; },
    createClient: () => {
      attempts += 1;
      const client = new FakeClient(new Error('timeout expired'));
      clients.push(client);
      return client;
    },
    sleep: async (milliseconds) => { delays.push(milliseconds); }, random: () => 0,
  }), (error: unknown) => error instanceof StreamMetadataError && error.classification === 'DB_CONNECTION_TRANSIENT');
  assert.equal(attempts, 3);
  assert.equal(tokens, 3);
  assert.deepEqual(delays, [0, 0]);
  assert.ok(clients.every((client) => client.queries.length === 0));
});

test('IAM tokens and connection configuration never enter retry logs', async () => {
  const entries: unknown[] = [];
  await assert.rejects(DatabaseSession.connect(config, budget, { log: (entry) => { entries.push(entry); } }, {
    readCa: async () => 'CA', createToken: async () => 'super-secret-token',
    createClient: () => new FakeClient({ code: '08006', message: 'super-secret-token' }),
    sleep: async () => undefined, random: () => 0,
  }));
  const serialized = JSON.stringify(entries);
  assert.doesNotMatch(serialized, /super-secret-token|db\.example|stream_insight/);
  assert.match(serialized, /DB_CONNECTION_TRANSIENT/);
});

test('pre-commit failure rolls back while commit rejection is COMMIT_OUTCOME_UNKNOWN without rollback', async () => {
  const preCommit = new FakeClient();
  const first = await DatabaseSession.connect(config, budget, logger, {
    readCa: async () => 'CA', createToken: async () => 'token', createClient: () => preCommit,
  });
  await assert.rejects(first.transaction(async () => { throw new StreamMetadataError('STATE_CONFLICT', 'conflict'); }, budget), StreamMetadataError);
  assert.deepEqual(preCommit.queries, ['BEGIN', 'ROLLBACK']);

  const commit = new FakeClient(undefined, (sql) => sql === 'COMMIT' ? { code: 'ECONNRESET' } : undefined);
  const second = await DatabaseSession.connect(config, budget, logger, {
    readCa: async () => 'CA', createToken: async () => 'token', createClient: () => commit,
  });
  await assert.rejects(second.transaction(async () => 'ok', budget),
    (error: unknown) => error instanceof StreamMetadataError && error.classification === 'COMMIT_OUTCOME_UNKNOWN');
  assert.deepEqual(commit.queries, ['BEGIN', 'COMMIT']);
  assert.equal(commit.destroyCount, 1);
});

test('pre-COMMIT time budget failure remains TIME_BUDGET and rolls back without sending COMMIT', async () => {
  let remaining = 60_000;
  const changingBudget = { getRemainingTimeInMillis: () => remaining };
  const client = new FakeClient();
  const session = await DatabaseSession.connect(config, changingBudget, logger, {
    readCa: async () => 'CA', createToken: async () => 'token', createClient: () => client,
  });
  await assert.rejects(session.transaction(async () => {
    remaining = 15_000;
    return 'ok';
  }, changingBudget),
  (error: unknown) => error instanceof StreamMetadataError && error.classification === 'TIME_BUDGET');
  assert.deepEqual(client.queries, ['BEGIN', 'ROLLBACK']);
});

for (const [code, classification] of [
  ['40001', 'DB_TRANSACTION_TRANSIENT'],
  ['40P01', 'DB_TRANSACTION_TRANSIENT'],
  ['23505', 'DB_CONSTRAINT'],
  ['42501', 'DB_AUTHORIZATION'],
] as const) {
  test(`COMMIT SQLSTATE ${code} preserves ${classification} without rollback or resend`, async () => {
    const client = new FakeClient(undefined, (sql) => sql === 'COMMIT' ? { code } : undefined);
    const session = await DatabaseSession.connect(config, budget, logger, {
      readCa: async () => 'CA', createToken: async () => 'token', createClient: () => client,
    });
    await assert.rejects(session.transaction(async () => 'ok', budget),
      (error: unknown) => error instanceof StreamMetadataError && error.classification === classification);
    assert.deepEqual(client.queries, ['BEGIN', 'COMMIT']);
    assert.equal(client.destroyCount, 0);
  });
}

test('rollback failure preserves the original classification and successful commit is sent once', async () => {
  const rollback = new FakeClient(undefined, (sql) => sql === 'ROLLBACK' ? { code: '08006' } : undefined);
  const first = await DatabaseSession.connect(config, budget, logger, {
    readCa: async () => 'CA', createToken: async () => 'token', createClient: () => rollback,
  });
  await assert.rejects(first.transaction(async () => { throw new StreamMetadataError('STATE_CONFLICT', 'original'); }, budget),
    (error: unknown) => error instanceof StreamMetadataError && error.classification === 'STATE_CONFLICT');
  assert.equal(rollback.destroyCount, 1);

  const committed = new FakeClient();
  const second = await DatabaseSession.connect(config, budget, logger, {
    readCa: async () => 'CA', createToken: async () => 'token', createClient: () => committed,
  });
  assert.equal(await second.transaction(async () => 'ok', budget), 'ok');
  assert.deepEqual(committed.queries, ['BEGIN', 'COMMIT']);
});

test('hanging rollback is bounded, destroys the socket and preserves the original error', async () => {
  const timers = new ControlledTimers();
  const client = new FakeClient(
    undefined,
    (sql) => sql === 'ROLLBACK' ? new Promise<never>(() => undefined) : undefined,
    'hang',
  );
  const session = await DatabaseSession.connect(config, budget, logger, {
    readCa: async () => 'CA', createToken: async () => 'token', createClient: () => client,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  const transaction = session.transaction(async () => { throw new StreamMetadataError('STATE_CONFLICT', 'original'); }, budget);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(timers.pending.size, 1);
  timers.fireNext();
  await assert.rejects(transaction,
    (error: unknown) => error instanceof StreamMetadataError && error.classification === 'STATE_CONFLICT');
  assert.deepEqual(client.queries, ['BEGIN', 'ROLLBACK']);
  assert.equal(client.destroyCount, 1);
  assert.equal(timers.pending.size, 0);
  const closing = session.close();
  await new Promise<void>((resolve) => setImmediate(resolve));
  timers.fireNext();
  await closing;
  assert.equal(client.destroyCount, 2);
  assert.deepEqual(timers.durations, [3_000, 1_000]);
});

test('rollback skips new I/O when cleanup budget is exhausted and preserves the original error', async () => {
  let remaining = 60_000;
  const changingBudget = { getRemainingTimeInMillis: () => remaining };
  const client = new FakeClient();
  const session = await DatabaseSession.connect(config, changingBudget, logger, {
    readCa: async () => 'CA', createToken: async () => 'token', createClient: () => client,
  });
  await assert.rejects(session.transaction(async () => {
    remaining = 1_500;
    throw new StreamMetadataError('STATE_CONFLICT', 'original');
  }, changingBudget),
  (error: unknown) => error instanceof StreamMetadataError && error.classification === 'STATE_CONFLICT');
  assert.deepEqual(client.queries, ['BEGIN']);
  assert.equal(client.destroyCount, 1);
});

test('bounded close clears timers and destroys the socket only for timeout or rejection', async () => {
  for (const [endResult, shouldDestroy] of [
    ['success', false],
    ['reject', true],
    ['hang', true],
  ] as const) {
    const timers = new ControlledTimers();
    const client = new FakeClient(undefined, undefined, endResult);
    const session = await DatabaseSession.connect(config, budget, logger, {
      readCa: async () => 'CA', createToken: async () => 'token', createClient: () => client,
      setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    const closing = session.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (endResult === 'hang') timers.fireNext();
    await closing;
    assert.equal(client.destroyCount, shouldDestroy ? 1 : 0, endResult);
    assert.equal(timers.pending.size, 0, endResult);
    assert.equal(timers.clearCount, 1, endResult);
    assert.deepEqual(timers.durations, [1_000], endResult);
  }
});

test('query SQLSTATE 42501 is DB_AUTHORIZATION and low budget fails before connecting', async () => {
  const client = new FakeClient(undefined, () => ({ code: '42501' }));
  const session = await DatabaseSession.connect(config, budget, logger, {
    readCa: async () => 'CA', createToken: async () => 'token', createClient: () => client,
  });
  await assert.rejects(session.query('SELECT 1'),
    (error: unknown) => error instanceof StreamMetadataError && error.classification === 'DB_AUTHORIZATION');
  await assert.rejects(DatabaseSession.connect(config, { getRemainingTimeInMillis: () => 5_000 }, logger, {
    readCa: async () => 'CA', createToken: async () => 'token', createClient: () => new FakeClient(),
  }), (error: unknown) => error instanceof StreamMetadataError && error.classification === 'TIME_BUDGET');
});

test('every query requires its 10-second timeout plus the 5-second rollback/close reserve', async () => {
  let remaining = 60_000;
  const changingBudget = { getRemainingTimeInMillis: () => remaining };
  const session = await DatabaseSession.connect(config, changingBudget, logger, {
    readCa: async () => 'CA', createToken: async () => 'token', createClient: () => new FakeClient(),
  });
  remaining = 15_000;
  await assert.rejects(session.query('SELECT 1'),
    (error: unknown) => error instanceof StreamMetadataError && error.classification === 'TIME_BUDGET');
});
