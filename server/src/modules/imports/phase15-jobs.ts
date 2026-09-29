import { z } from 'zod';

import { LocalDiskStorage } from '../../integrations/storage/storage';

import { createImportsService } from './phase15-service';

const importJobSchema = z.strictObject({
  orgId: z.uuid(),
  batchId: z.uuid(),
  actorId: z.uuid(),
  step: z.enum(['validate', 'commit']),
});

export async function runPhase15ImportJob(data: unknown): Promise<unknown> {
  const job = importJobSchema.parse(data);
  const { createLocalAuthDependencies } = await import('../../config');
  const dependencies = await createLocalAuthDependencies();
  const imports = createImportsService(
    dependencies.database,
    dependencies.encryption,
    new LocalDiskStorage('data/uploads'),
  );
  if (job.step === 'validate')
    return imports.validateBatch(job.orgId, job.batchId, job.actorId);
  return imports.commitBatch(job.orgId, job.batchId, job.actorId);
}
