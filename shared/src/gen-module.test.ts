import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const generator = resolve('scripts/gen-module.mjs');

function generate(name: string, root: string, track = 'a') {
  return spawnSync(
    process.execPath,
    [generator, name, '--root', root, '--track', track],
    {
      encoding: 'utf8',
    },
  );
}

describe('module generator', () => {
  it('creates an inactive, tenant-aware module in the assigned range', async () => {
    const root = await mkdtemp(join(tmpdir(), 'athlentry-generator-'));
    try {
      const result = generate('people', root);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('migration 0011');
      const files = await readdir(join(root, 'server/src/modules/people'));
      expect(files).toHaveLength(7);
      expect(files).toContain('module.ts.template');
      const migration = await readFile(
        join(root, 'db/migrations/0011_people.sql.template'),
        'utf8',
      );
      expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
      expect(migration).toContain(
        "NULLIF(current_setting('app.org_id', true), '')::uuid",
      );
      expect(generate('people', root).status).not.toBe(0);
      expect(await readdir(join(root, 'db/migrations'))).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid names and modules assigned to another track', async () => {
    const root = await mkdtemp(join(tmpdir(), 'athlentry-generator-'));
    try {
      expect(generate('../people', root).status).not.toBe(0);
      expect(generate('files', root).status).not.toBe(0);
      expect(generate('files', root, 'c').status).toBe(0);
      expect(await readdir(join(root, 'db/migrations'))).toEqual([
        '0500_files.sql.template',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
