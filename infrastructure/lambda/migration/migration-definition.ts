import { createHash } from 'node:crypto';
import { Dirent, readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { TextDecoder } from 'node:util';

const VERSION_PATTERN = /^([0-9]+)_([a-z][a-z0-9_]*)$/;
const SQL_FILE_PATTERN = /^([0-9]+)_([a-z][a-z0-9_]*)\.sql$/;
const MAX_POSTGRES_INTEGER = 2_147_483_647;
const MAX_SQL_BYTES = 65_536;
const CHECKSUM_FORMAT = 'stream-insight-migration-checksum-v1';

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type MigrationErrorCode =
  | 'CONFIGURATION'
  | 'DEFINITION_INVALID'
  | 'CHECKSUM_MISMATCH'
  | 'LOCK_TIMEOUT'
  | 'DATA_API'
  | 'TRANSACTION_INDETERMINATE'
  | 'RESPONSE_SEND'
  | 'TIME_BUDGET';

export class MigrationError extends Error {
  public readonly cause?: unknown;

  constructor(
    public readonly code: MigrationErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message);
    this.name = 'MigrationError';
    this.cause = options?.cause;
  }
}

export interface MigrationSqlFile {
  readonly sequence: number;
  readonly fileName: string;
  readonly relativePath: string;
  readonly sql: string;
  readonly bytes: Buffer;
}

export interface MigrationDefinition {
  readonly version: number;
  readonly name: string;
  readonly directoryName: string;
  readonly checksum: string;
  readonly sqlFiles: readonly MigrationSqlFile[];
}

function invalid(message: string): never {
  throw new MigrationError('DEFINITION_INVALID', message);
}

function parsePositiveInteger(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_POSTGRES_INTEGER) {
    invalid(`${label} must be between 1 and ${MAX_POSTGRES_INTEGER}`);
  }
  return value;
}

function ensureOrdinaryDirectory(entry: Dirent, label: string): void {
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    invalid(`${label} must be an ordinary directory`);
  }
}

function readSqlFile(root: string, directoryName: string, entry: Dirent): MigrationSqlFile {
  if (entry.isSymbolicLink() || !entry.isFile()) {
    invalid(`Unexpected entry in ${directoryName}: ${entry.name}`);
  }

  const match = SQL_FILE_PATTERN.exec(entry.name);
  if (!match) {
    invalid(`Invalid SQL file name in ${directoryName}: ${entry.name}`);
  }

  const sequence = parsePositiveInteger(match[1], `SQL sequence ${entry.name}`);
  const relativePath = posix.join(directoryName, entry.name);
  const bytes = readFileSync(join(root, directoryName, entry.name));
  if (bytes.length === 0 || bytes.length > MAX_SQL_BYTES) {
    invalid(`SQL file size is invalid: ${relativePath}`);
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    invalid(`UTF-8 BOM is not allowed: ${relativePath}`);
  }

  let sql: string;
  try {
    sql = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new MigrationError('DEFINITION_INVALID', `SQL file is not valid UTF-8: ${relativePath}`, {
      cause: error,
    });
  }
  if (sql.includes('\r')) {
    invalid(`CR characters are not allowed in SQL files: ${relativePath}`);
  }
  if (sql.trim().length === 0) {
    invalid(`SQL file must not be blank: ${relativePath}`);
  }

  return { sequence, fileName: entry.name, relativePath, sql, bytes };
}

function calculateChecksum(
  directoryName: string,
  sqlFiles: readonly MigrationSqlFile[],
): string {
  const hash = createHash('sha256');
  hash.update(CHECKSUM_FORMAT);
  hash.update('\0');
  hash.update(directoryName);
  hash.update('\0');
  for (const file of sqlFiles) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(String(file.bytes.length));
    hash.update('\0');
    hash.update(file.bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function discoverMigrations(root: string): readonly MigrationDefinition[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    throw new MigrationError('DEFINITION_INVALID', 'Migration root cannot be read', { cause: error });
  }

  const versions = new Set<number>();
  const migrations = entries.map((entry) => {
    ensureOrdinaryDirectory(entry, `Migration entry ${entry.name}`);
    const match = VERSION_PATTERN.exec(entry.name);
    if (!match) {
      return invalid(`Invalid migration directory name: ${entry.name}`);
    }
    const version = parsePositiveInteger(match[1], `Migration version ${entry.name}`);
    if (versions.has(version)) {
      return invalid(`Duplicate migration version: ${version}`);
    }
    versions.add(version);

    const sqlEntries = readdirSync(join(root, entry.name), { withFileTypes: true });
    if (sqlEntries.length === 0) {
      return invalid(`Migration directory must not be empty: ${entry.name}`);
    }
    const sequences = new Set<number>();
    const sqlFiles = sqlEntries.map((sqlEntry) => {
      const file = readSqlFile(root, entry.name, sqlEntry);
      if (sequences.has(file.sequence)) {
        return invalid(`Duplicate SQL sequence in ${entry.name}: ${file.sequence}`);
      }
      sequences.add(file.sequence);
      return file;
    });
    sqlFiles.sort((a, b) => a.sequence - b.sequence || compareAscii(a.fileName, b.fileName));

    return {
      version,
      name: match[2],
      directoryName: entry.name,
      checksum: calculateChecksum(entry.name, sqlFiles),
      sqlFiles,
    };
  });

  migrations.sort((a, b) => a.version - b.version || compareAscii(a.directoryName, b.directoryName));
  return migrations;
}
