import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discoverMigrations, MigrationError } from '../lambda/migration/migration-definition';
import { calculateMigrationBundleHash } from '../lib/migration-assets';

function withMigrationRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'stream-insight-migrations-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeMigration(root: string, directory: string, files: Record<string, string | Buffer>): void {
  const migrationDirectory = join(root, directory);
  mkdirSync(migrationDirectory);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(migrationDirectory, name), content);
  }
}

test('discovers valid versions and sorts versions and SQL files numerically', () => {
  withMigrationRoot((root) => {
    writeMigration(root, '1000_later', { '010_second.sql': 'SELECT 2\n', '002_first.sql': 'SELECT 1\n' });
    writeMigration(root, '001_initial', { '001_table.sql': 'SELECT 1\n' });
    const migrations = discoverMigrations(root);
    assert.deepEqual(migrations.map((item) => item.version), [1, 1000]);
    assert.deepEqual(migrations[1].sqlFiles.map((item) => item.sequence), [2, 10]);
  });
});

test('rejects duplicate numeric versions', () => {
  withMigrationRoot((root) => {
    writeMigration(root, '001_initial', { '001_a.sql': 'SELECT 1\n' });
    writeMigration(root, '1_duplicate', { '001_b.sql': 'SELECT 2\n' });
    assert.throws(() => discoverMigrations(root), MigrationError);
  });
});

test('rejects duplicate SQL sequences', () => {
  withMigrationRoot((root) => {
    writeMigration(root, '001_initial', {
      '001_a.sql': 'SELECT 1\n',
      '1_b.sql': 'SELECT 2\n',
    });
    assert.throws(() => discoverMigrations(root), MigrationError);
  });
});

for (const directory of ['bad-name', '0_zero']) {
  test(`rejects invalid migration directory ${directory}`, () => {
    withMigrationRoot((root) => {
      writeMigration(root, directory, { '001_a.sql': 'SELECT 1\n' });
      assert.throws(() => discoverMigrations(root), MigrationError);
    });
  });
}

test('rejects invalid SQL filename and empty version directory', () => {
  withMigrationRoot((root) => {
    writeMigration(root, '001_initial', { 'readme.txt': 'not sql' });
    assert.throws(() => discoverMigrations(root), MigrationError);
  });
  withMigrationRoot((root) => {
    mkdirSync(join(root, '001_initial'));
    assert.throws(() => discoverMigrations(root), MigrationError);
  });
});

test('rejects BOM and blank SQL', () => {
  withMigrationRoot((root) => {
    writeMigration(root, '001_initial', {
      '001_a.sql': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('SELECT 1\n')]),
    });
    assert.throws(() => discoverMigrations(root), MigrationError);
  });
  withMigrationRoot((root) => {
    writeMigration(root, '001_initial', { '001_a.sql': ' \n' });
    assert.throws(() => discoverMigrations(root), MigrationError);
  });
});

test('checksum is deterministic and changes with SQL bytes', () => {
  withMigrationRoot((root) => {
    writeMigration(root, '001_initial', { '001_a.sql': 'SELECT 1\n' });
    const first = discoverMigrations(root)[0].checksum;
    const second = discoverMigrations(root)[0].checksum;
    assert.equal(first, second);
    writeFileSync(join(root, '001_initial', '001_a.sql'), 'SELECT 2\n');
    assert.notEqual(discoverMigrations(root)[0].checksum, first);
  });
});

test('rejects CR characters and SQL assets larger than the safe Data API limit', () => {
  withMigrationRoot((root) => {
    writeMigration(root, '001_initial', { '001_a.sql': 'SELECT 1\r\n' });
    assert.throws(() => discoverMigrations(root), MigrationError);
  });
  withMigrationRoot((root) => {
    writeMigration(root, '001_initial', { '001_a.sql': 'x'.repeat(65_537) });
    assert.throws(() => discoverMigrations(root), MigrationError);
  });
});

test('MigrationBundleHash is deterministic and changes with content and path', () => {
  withMigrationRoot((root) => {
    writeMigration(root, '001_initial', { '001_a.sql': 'SELECT 1\n' });
    const first = calculateMigrationBundleHash(root);
    assert.equal(calculateMigrationBundleHash(root), first);
    writeFileSync(join(root, '001_initial', '001_a.sql'), 'SELECT 2\n');
    const contentChanged = calculateMigrationBundleHash(root);
    assert.notEqual(contentChanged, first);
    renameSync(
      join(root, '001_initial', '001_a.sql'),
      join(root, '001_initial', '002_b.sql'),
    );
    assert.notEqual(calculateMigrationBundleHash(root), contentChanged);
  });
});

test('MigrationBundleHash frames file boundaries unambiguously', () => {
  withMigrationRoot((singleFileRoot) => {
    withMigrationRoot((twoFileRoot) => {
      const secondPath = '001_initial/002_b.sql';
      writeMigration(singleFileRoot, '001_initial', {
        '001_a.sql': Buffer.from(`SELECT 1\0${secondPath}\0SELECT 2`),
      });
      writeMigration(twoFileRoot, '001_initial', {
        '001_a.sql': 'SELECT 1',
        '002_b.sql': 'SELECT 2',
      });
      assert.notEqual(
        calculateMigrationBundleHash(singleFileRoot),
        calculateMigrationBundleHash(twoFileRoot),
      );
    });
  });
});
