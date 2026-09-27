import { serverModules } from './generated/registry';
import { startRegisteredWorker } from './modules/jobs/runtime';

const connectionString = process.env.DATABASE_URL;
if (!connectionString)
  throw new Error('DATABASE_URL is required for the worker');

const worker = await startRegisteredWorker(serverModules, connectionString);
process.stdout.write(`Athlentry worker ready: ${worker.id}\n`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void worker.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        process.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exit(1);
      },
    );
  });
}
