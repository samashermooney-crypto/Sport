import { z } from 'zod';

const auditEntrySchema = z.strictObject({
  id: z.uuid(),
  orgId: z.uuid(),
  actorAccountId: z.uuid().nullable(),
  impersonationId: z.uuid().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.uuid().nullable(),
  changes: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime({ offset: true }),
});
export const auditPageSchema = z.strictObject({
  items: z.array(auditEntrySchema),
  nextCursor: z.string().nullable(),
});
