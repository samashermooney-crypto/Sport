// Phase 0 starts the worker process; Phase 1 registers pg-boss jobs.
process.stdout.write('Athlentry worker process ready\n');
const timer = setInterval(() => undefined, 60_000);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    process.exit(0);
  });
}
