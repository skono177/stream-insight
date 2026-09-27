import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { discoverMigrations } from '../lambda/migration/migration-definition';

const BUNDLE_HASH_FORMAT = 'stream-insight-migration-bundle-v2';

function updateFrame(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  hash.update(length);
  hash.update(bytes);
}

export function calculateMigrationBundleHash(migrationsRoot: string): string {
  const migrations = discoverMigrations(migrationsRoot);
  const hash = createHash('sha256');
  updateFrame(hash, BUNDLE_HASH_FORMAT);
  for (const migration of migrations) {
    for (const file of migration.sqlFiles) {
      updateFrame(hash, file.relativePath.split('\\').join('/'));
      updateFrame(hash, file.bytes);
    }
  }
  return hash.digest('hex');
}

export function migrationPaths(projectRoot: string): {
  readonly root: string;
  readonly copyScript: string;
} {
  return {
    root: join(projectRoot, 'lambda', 'migration', 'migrations'),
    copyScript: join(projectRoot, 'scripts', 'copy-migrations.cjs'),
  };
}
