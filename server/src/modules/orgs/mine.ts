import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';

export async function listMyOrganizations(
  database: Kysely<DB>,
  accountId: string,
) {
  const account = await database
    .selectFrom('accounts')
    .select('linked_org_ids')
    .where('id', '=', accountId)
    .executeTakeFirst();
  if (!account) return [];
  const withOrg = createWithOrg(database);
  const organizations = await Promise.all(
    account.linked_org_ids.map((orgId) =>
      withOrg({ orgId, actor: { accountId } }, async (trx) => {
        const membership = await trx
          .selectFrom('org_memberships')
          .select('id')
          .where('org_id', '=', orgId)
          .where('account_id', '=', accountId)
          .where('status', '=', 'active')
          .executeTakeFirst();
        if (!membership) return null;
        return trx
          .selectFrom('organizations')
          .select(['id', 'name', 'slug'])
          .where('id', '=', orgId)
          .where('status', 'in', ['active', 'onboarding'])
          .executeTakeFirst();
      }),
    ),
  );
  return organizations
    .filter((org): org is NonNullable<typeof org> => Boolean(org))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
