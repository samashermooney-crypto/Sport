import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../../server/src/db/kysely';
import { createWithOrg } from '../../server/src/db/withOrg';
import { issueSession } from '../../server/src/modules/auth/sessions';
import { createTestFactories } from '../../server/test/factories';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('QA-SEC-013 / Track I: class browse cannot infer age bands for an unlinked person', async ({
  request,
}) => {
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  const withOrg = createWithOrg(database);

  try {
    const factories = createTestFactories(database);
    const organization = await factories.actor();
    const unrelatedMember = await factories.actor();
    const program = await factories.program(organization);
    const personId = await factories.person(organization, {
      firstName: 'AgeInferencePrivate',
      dateOfBirth: '2013-04-02',
    });

    await withOrg(organization, async (trx) => {
      await trx
        .updateTable('programs')
        .set({ status: 'published' })
        .where('org_id', '=', organization.orgId)
        .where('id', '=', program.programId)
        .execute();
      await trx
        .insertInto('org_memberships')
        .values({
          id: newId(),
          org_id: organization.orgId,
          account_id: unrelatedMember.accountId,
          status: 'active',
          joined_at: new Date(),
        })
        .execute();
      for (const band of [
        { name: 'Age band under 10', min: 0, max: 119 },
        { name: 'Age band U12', min: 120, max: 155 },
        { name: 'Age band U16', min: 156, max: 191 },
      ]) {
        await trx
          .insertInto('class_offerings')
          .values({
            id: newId(),
            org_id: organization.orgId,
            program_id: program.programId,
            name: band.name,
            age_min_months: band.min,
            age_max_months: band.max,
            capacity: 12,
            instructor_ratio: '8',
            billing: 'term',
            price_cents: 0,
          })
          .execute();
      }
    });

    const session = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: unrelatedMember.accountId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        new Date(),
      ),
    );
    const response = await request.get(
      `http://127.0.0.1:${String(3001 + offset)}/api/v1/classes/orgs/${organization.orgId}/me/browse?personId=${personId}`,
      {
        headers: {
          Cookie: `__Host-athlentry_session=${session.token}`,
        },
      },
    );

    expect(response.status()).toBe(403);
    expect(await response.text()).not.toContain('AgeInferencePrivate');
  } finally {
    await database.destroy();
  }
});
