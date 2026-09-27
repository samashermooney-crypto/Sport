import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

const e2e = process.argv.includes('--e2e');
const dbName = e2e ? 'athlentry_e2e' : 'athlentry_dev';
const env = {
  ...process.env,
  ...(e2e
    ? { APP_URL: 'https://127.0.0.1:5173', ATHLENTRY_E2E_HTTPS: '1' }
    : {}),
  DATABASE_URL: `postgres://athlentry_app@127.0.0.1:5432/${dbName}`,
  DATABASE_ADMIN_URL: `postgres://athlentry_admin@127.0.0.1:5432/${dbName}`,
};
const colors = {
  compose: '\x1b[36m',
  migrate: '\x1b[35m',
  api: '\x1b[32m',
  worker: '\x1b[33m',
  web: '\x1b[34m',
};
const reset = '\x1b[0m';
const children = new Set();
let stopping = false;

function prefixStream(stream, label) {
  const lines = createInterface({ input: stream });
  lines.on('line', (line) =>
    process.stdout.write(`${colors[label]}[${label}]${reset} ${line}\n`),
  );
}

function run(label, command, args, options = {}) {
  const child = spawn(command, args, {
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
    ...options,
  });
  children.add(child);
  prefixStream(child.stdout, label);
  prefixStream(child.stderr, label);
  child.on('exit', (code) => {
    children.delete(child);
    if (!stopping && options.longRunning) {
      process.stderr.write(`[${label}] exited with code ${code}\n`);
      void stop(code || 1);
    }
  });
  return child;
}

function done(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Command exited with ${code}`)),
    );
  });
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  await Promise.allSettled([...children].map(done));
  await done(run('compose', 'docker', ['compose', 'down'])).catch(
    () => undefined,
  );
  process.exit(code);
}

process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());

try {
  if (e2e) {
    const certificate = resolve('data/dev-localhost.crt');
    const key = resolve('data/dev-localhost.key');
    if (!existsSync(certificate) || !existsSync(key)) {
      mkdirSync(resolve('data'), { recursive: true });
      const result = spawnSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '365',
          '-keyout',
          key,
          '-out',
          certificate,
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost,IP:127.0.0.1',
        ],
        { stdio: 'ignore' },
      );
      if (result.status !== 0)
        throw new Error('Could not create the local HTTPS certificate');
    }
    chmodSync(key, 0o600);
  }
  await done(
    run('compose', 'docker', [
      'compose',
      'up',
      '-d',
      '--wait',
      'postgres',
      'stripe-mock',
      'mailpit',
    ]),
  );
  await done(
    run('migrate', 'npm', [
      'run',
      e2e ? 'db:seed' : 'db:migrate',
      ...(e2e ? ['--', '--profile', 'e2e'] : []),
    ]),
  );
  run('api', 'node_modules/.bin/tsx', ['watch', 'server/src/main.ts'], {
    longRunning: true,
  });
  run('worker', 'node_modules/.bin/tsx', ['watch', 'server/src/worker.ts'], {
    longRunning: true,
  });
  run('web', 'node_modules/.bin/vite', ['--config', 'vite.config.ts'], {
    longRunning: true,
  });
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  await stop(1);
}
