import { spawnSync } from 'node:child_process';

const generated = spawnSync(
  'node_modules/.bin/kysely-codegen',
  [
    '--dialect',
    'postgres',
    '--out-file',
    'server/src/db/types.ts',
    '--numeric-parser',
    'number',
    '--type-mapping',
    '{"int8":"number"}',
  ],
  {
    env: {
      ...process.env,
      DATABASE_URL:
        process.env.DATABASE_ADMIN_URL ??
        'postgres://athlentry_admin@127.0.0.1:5432/athlentry_dev',
    },
    stdio: 'inherit',
  },
);
if (generated.error) throw generated.error;
if (generated.status !== 0) process.exit(generated.status ?? 1);

const formatted = spawnSync(
  'node_modules/.bin/prettier',
  ['--write', 'server/src/db/types.ts'],
  { stdio: 'inherit' },
);
if (formatted.error) throw formatted.error;
process.exitCode = formatted.status ?? 1;
