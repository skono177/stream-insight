import assert from 'node:assert/strict';
import test from 'node:test';
import { RdsDataApi } from '../lambda/migration/data-api';
import { MigrationError } from '../lambda/migration/migration-definition';

const config = (remainingTime: () => number) => ({
  resourceArn: 'cluster-arn',
  secretArn: 'secret-arn',
  database: 'stream_insight',
  remainingTime,
});

test('Data API supplies AbortSignal, uses remaining time, and clears its timer', async () => {
  let signal: AbortSignal | undefined;
  let timeout = 0;
  let clears = 0;
  const api = new RdsDataApi(config(() => 25_000), {
    send: async (_command, options) => {
      signal = options.abortSignal;
      return { transactionId: 'transaction-id' };
    },
    setTimer: (_callback, milliseconds) => {
      timeout = milliseconds;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {
      clears += 1;
    },
  });

  assert.equal(await api.beginTransaction(), 'transaction-id');
  assert.ok(signal);
  assert.equal(signal.aborted, false);
  assert.equal(timeout, 15_000);
  assert.equal(clears, 1);
});

test('Data API aborts a timed-out request and clears the timer', async () => {
  let timerCallback: (() => void) | undefined;
  let clears = 0;
  const api = new RdsDataApi(config(() => 300_000), {
    send: async (_command, options) =>
      new Promise((_resolve, reject) => {
        options.abortSignal.addEventListener('abort', () => {
          const error = new Error('request aborted');
          error.name = 'AbortError';
          reject(error);
        });
        queueMicrotask(() => timerCallback?.());
      }),
    setTimer: (callback) => {
      timerCallback = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {
      clears += 1;
    },
  });

  await assert.rejects(
    api.executeOutsideTransaction('SELECT 1'),
    (error: unknown) => error instanceof MigrationError && error.code === 'TIME_BUDGET',
  );
  assert.equal(clears, 1);
});

test('Data API does not send a command when response reserve is unavailable', async () => {
  let sends = 0;
  const api = new RdsDataApi(config(() => 10_000), {
    send: async () => {
      sends += 1;
      return {};
    },
  });
  await assert.rejects(api.executeOutsideTransaction('SELECT 1'), MigrationError);
  assert.equal(sends, 0);
});

test('Data API honors a shorter caller deadline', async () => {
  let timeout = 0;
  const api = new RdsDataApi(config(() => 300_000), {
    send: async () => ({}),
    setTimer: (_callback, milliseconds) => {
      timeout = milliseconds;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => undefined,
  });
  await api.executeOutsideTransaction('SELECT 1', undefined, 5_000);
  assert.equal(timeout, 5_000);
});
