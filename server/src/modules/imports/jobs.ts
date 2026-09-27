import { z } from 'zod';

import { getDatabase } from '../../db/kysely';
import { LocalDiskStorage } from '../../integrations/storage/storage';
import { systemWorkerActorId } from '../jobs/credentials-expiry';

import { ImportsError, createImportsService } from './service';
import { setBatchFailed } from './service-support';

const jobData = z.strictObject({
  orgId: z.string(),
  batchId: z.string(),
  actorId: z.string().optional(),
  step: z.enum(['validate', 'commit']),
});

async function runImportProcess(data: unknown): Promise<unknown> {
  const { orgId, batchId, step, actorId } = jobData.parse(data);
  const database = getDatabase();
  const service = createImportsService(
    database,
    null,
    new LocalDiskStorage('data/uploads'),
  );
  const actor = actorId ?? systemWorkerActorId;
  try {
    if (step === 'validate') {
      return await service.validateBatch(orgId, batchId, actor);
    }
    return await service.commitBatch(orgId, batchId, actor);
  } catch (error) {
    if (error instanceof ImportsError && error.status === 404) return null;
    await setBatchFailed(database, orgId, batchId);
    throw error;
  }
}

export const importsJobs = [{ name: 'imports.process', run: runImportProcess }];
