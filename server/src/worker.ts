import { serverModules } from './generated/registry';
import { writeStructuredLog } from './lib/observability/logging';
import {
  captureRedactedException,
  initSentry,
} from './lib/observability/sentry';
import { startRegisteredWorker } from './modules/jobs/runtime';

const connectionString = process.env.DATABASE_URL;
if (!connectionString)
  throw new Error('DATABASE_URL is required for the worker');

initSentry();
const worker = await startRegisteredWorker(serverModules, connectionString);
writeStructuredLog('info', 'worker.ready', { module: 'worker' });
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void worker.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        writeStructuredLog('error', 'worker.shutdown_failed', {
          module: 'worker',
          result: 'failed',
        });
        captureRedactedException(error);
        process.stderr.write('Worker shutdown failed\n');
        process.exit(1);
      },
    );
  });
}
