import { serverModules } from './generated/registry';

const jobNames = serverModules.flatMap((module) => module.jobs ?? []);
process.stdout.write(
  `Athlentry worker process ready; ${String(jobNames.length)} jobs declared\n`,
);
const timer = setInterval(() => undefined, 60_000);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    process.exit(0);
  });
}
