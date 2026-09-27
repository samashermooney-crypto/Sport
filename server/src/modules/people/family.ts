import { ageOnDate, orgToday } from '@shared/dates';
import { familyResponseSchema } from '@shared/schemas/people';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';

export async function listFamily(database: Kysely<DB>, accountId: string) {
  const account = await database
    .selectFrom('accounts')
    .select('linked_org_ids')
    .where('id', '=', accountId)
    .where('status', '=', 'active')
    .where('email_verified_at', 'is not', null)
    .executeTakeFirst();
  if (!account) return familyResponseSchema.parse({ organizations: [] });
  const withOrg = createWithOrg(database);
  const organizations = [];
  for (const orgId of account.linked_org_ids) {
    const family = await withOrg(
      { orgId, actor: { accountId } },
      async (trx) => {
        const org = await trx
          .selectFrom('organizations')
          .select(['name', 'timezone'])
          .where('id', '=', orgId)
          .where('status', 'in', ['active', 'onboarding'])
          .executeTakeFirst();
        if (!org) return null;
        const rows = await trx
          .selectFrom('person_account_links as link')
          .innerJoin('people as person', (join) =>
            join
              .onRef('person.org_id', '=', 'link.org_id')
              .onRef('person.id', '=', 'link.person_id'),
          )
          .select([
            'person.id as person_id',
            'person.first_name',
            'person.last_name',
            'person.date_of_birth',
            'link.relationship',
          ])
          .where('link.org_id', '=', orgId)
          .where('link.account_id', '=', accountId)
          .where('link.revoked_at', 'is', null)
          .where('link.verified_at', 'is not', null)
          .where('person.status', '=', 'active')
          .orderBy('person.last_name')
          .orderBy('person.first_name')
          .execute();
        if (rows.length === 0) return null;
        const today = orgToday(org.timezone);
        return {
          orgId,
          orgName: org.name,
          people: rows.map((row) => ({
            personId: row.person_id,
            firstName: row.first_name,
            lastName: row.last_name,
            age: ageOnDate(row.date_of_birth.toISOString().slice(0, 10), today),
            relationship: row.relationship,
          })),
        };
      },
    );
    if (family) organizations.push(family);
  }
  organizations.sort((a, b) => a.orgName.localeCompare(b.orgName));
  return familyResponseSchema.parse({ organizations });
}
