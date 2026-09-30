import { serverModules } from './generated/registry';
import { createStorageAdapterFromEnvironment } from './integrations/storage/config';
import { writeStructuredLog } from './lib/observability/logging';
import { startOperationalAlerts } from './lib/observability/monitor';
import {
  initSentry,
  captureRedactedException,
} from './lib/observability/sentry';
import { startRegisteredWorker } from './modules/jobs/runtime';

async function main(): Promise<void> {
  initSentry();
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error('DATABASE_URL is required for the worker');

  writeStructuredLog('info', 'worker.starting');
  const worker = await startRegisteredWorker(
    serverModules,
    connectionString,
    createStorageAdapterFromEnvironment(),
  );
  const alerts = startOperationalAlerts(connectionString);
  writeStructuredLog('info', 'worker.ready', {
    operation: worker.id,
    result: 'ok',
  });
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void alerts
        .stop()
        .then(() => worker.stop())
        .then(
          () => process.exit(0),
          (error: unknown) => {
            captureRedactedException(error);
            writeStructuredLog('error', 'worker.stop.failed', {
              result: 'failed',
            });
            process.exit(1);
          },
        );
    });
  }
}

await main().catch((error: unknown) => {
  captureRedactedException(error);
  writeStructuredLog('error', 'worker.start.failed', { result: 'failed' });
  process.exitCode = 1;
});
