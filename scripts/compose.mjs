import { spawn } from 'node:child_process';

import { composePortEnv } from './ports.mjs';

const child = spawn('docker', ['compose', ...process.argv.slice(2)], {
  env: composePortEnv(),
  stdio: 'inherit',
});
child.on('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
