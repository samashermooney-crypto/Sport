import type { ServerModule } from '../../lib/module-contract';

export type RegisteredJob = {
  name: string;
  run: (data: unknown) => Promise<unknown>;
  cron?: string;
};

export function collectRegisteredJobs(
  modules: readonly ServerModule[],
): RegisteredJob[] {
  const result: RegisteredJob[] = [];
  const names = new Set<string>();
  for (const module of modules) {
    for (const declaration of module.jobs ?? []) {
      if (!/^[a-z][a-z0-9]*(?:[.-][a-z][a-z0-9]*)+$/.test(declaration.name))
        throw new RangeError(`Invalid job name in ${module.name}`);
      if (names.has(declaration.name))
        throw new RangeError(`Duplicate job name: ${declaration.name}`);
      const run = 'run' in declaration ? declaration.run : undefined;
      if (typeof run !== 'function')
        throw new TypeError(`Job has no handler: ${declaration.name}`);
      const cron = 'cron' in declaration ? declaration.cron : undefined;
      if (cron !== undefined && typeof cron !== 'string')
        throw new TypeError(`Invalid job schedule: ${declaration.name}`);
      result.push({
        name: declaration.name,
        run: run as RegisteredJob['run'],
        ...(cron === undefined ? {} : { cron }),
      });
      names.add(declaration.name);
    }
  }
  return result;
}
