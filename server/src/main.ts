import { createApp } from './app';
import { createLocalAuthDependencies } from './config';

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '127.0.0.1';
const auth = await createLocalAuthDependencies();
const server = createApp(auth).listen(port, host, () => {
  process.stdout.write(
    `Athlentry API listening on http://${host}:${String(port)}\n`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
