import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const e2e = process.argv.includes('--e2e');
const dbName = e2e ? 'athlentry_e2e' : 'athlentry_dev';
const env = {
  ...process.env,
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
