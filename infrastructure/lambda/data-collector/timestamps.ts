import { validationError } from './errors';

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

export function timestampMicros(value: string, label = 'timestamp'): bigint {
  const match = TIMESTAMP.exec(value);
  if (!match) throw validationError(`${label} must be a UTC-compatible RFC 3339 timestamp`);
  const [, year, month, day, hour, minute, second, fraction = '', zone] = match;
  const baseText = `${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`;
  const baseMillis = Date.parse(baseText);
  if (!Number.isFinite(baseMillis)) throw validationError(`${label} must be a valid RFC 3339 timestamp`);
  const localCheck = new Date(Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`));
  if (localCheck.getUTCFullYear() !== Number(year) || localCheck.getUTCMonth() + 1 !== Number(month) ||
      localCheck.getUTCDate() !== Number(day) || localCheck.getUTCHours() !== Number(hour) ||
      localCheck.getUTCMinutes() !== Number(minute) || localCheck.getUTCSeconds() !== Number(second)) {
    throw validationError(`${label} must be a valid RFC 3339 timestamp`);
  }
  const padded = `${fraction}0000000`;
  let micros = BigInt(padded.slice(0, 6));
  const seventh = padded[6];
  const remaining = fraction.slice(7);
  if (seventh > '5' || (seventh === '5' && (/[1-9]/.test(remaining) || micros % 2n === 1n))) micros += 1n;
  return BigInt(Math.trunc(baseMillis / 1_000)) * 1_000_000n + micros;
}

export function formatTimestampMicros(micros: bigint): string {
  let seconds = micros / 1_000_000n;
  let fraction = micros % 1_000_000n;
  if (fraction < 0) { seconds -= 1n; fraction += 1_000_000n; }
  const date = new Date(Number(seconds * 1_000n));
  if (!Number.isFinite(date.getTime())) throw validationError('timestamp is outside the supported range');
  return `${date.toISOString().slice(0, 19)}.${fraction.toString().padStart(6, '0')}Z`;
}

export const normalizeTimestamp = (value: string, label = 'timestamp'): string =>
  formatTimestampMicros(timestampMicros(value, label));

export const laterTimestamp = (left: string, right: string): string =>
  timestampMicros(left) >= timestampMicros(right) ? normalizeTimestamp(left) : normalizeTimestamp(right);
