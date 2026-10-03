const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/** Convert a PostgreSQL/RFC 3339 timestamp to PostgreSQL's microsecond precision. */
export function timestampInstant(value: Date | string | null): bigint | null {
  if (value === null) return null;
  if (value instanceof Date) return BigInt(value.getTime()) * 1_000n;
  const match = TIMESTAMP.exec(value);
  if (!match) return BigInt(new Date(value).getTime()) * 1_000n;
  const [, date, time, fraction = '', zone] = match;
  const normalizedZone = /^[+-]\d{2}$/.test(zone) ? `${zone}:00` : zone;
  const seconds = BigInt(new Date(`${date}T${time}${normalizedZone}`).getTime() / 1_000);
  const padded = `${fraction}0000000`;
  let micros = BigInt(padded.slice(0, 6));
  const roundDigit = padded[6];
  const aboveHalf = roundDigit > '5' || (roundDigit === '5' && /[1-9]/.test(fraction.slice(7)));
  const exactHalf = roundDigit === '5' && !/[1-9]/.test(fraction.slice(7));
  if (aboveHalf || (exactHalf && micros % 2n === 1n)) micros += 1n;
  return seconds * 1_000_000n + micros;
}

export const sameTimestamp = (left: Date | string | null, right: Date | string | null): boolean =>
  timestampInstant(left) === timestampInstant(right);
