import { orgSlugSchema } from '@shared/schemas/orgs';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';

export async function isOrgSlugAvailable(
  database: Kysely<DB>,
  candidate: string,
): Promise<boolean> {
  const parsed = orgSlugSchema.safeParse(candidate);
  if (!parsed.success) return false;
  const existing = await database
    .selectFrom('organizations')
    .select('id')
    .where('slug', '=', parsed.data)
    .executeTakeFirst();
  return !existing;
}
