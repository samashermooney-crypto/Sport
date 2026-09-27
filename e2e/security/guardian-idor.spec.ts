import { randomBytes, randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../../server/src/db/kysely';
import { createWithOrg } from '../../server/src/db/withOrg';
import { parseEncryptionKeys } from '../../server/src/lib/crypto';
import { issueSession } from '../../server/src/modules/auth/sessions';
import { createMedicalRepository } from '../../server/src/modules/people/medical';
import { createTestFactories } from '../../server/test/factories';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('guardian A family view and medical ID lookup exclude guardian B child', async ({
  request,
}) => {
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const factories = createTestFactories(database);
    const org = await factories.actor();
    const childA = await factories.person(org, {
      firstName: 'Private',
      lastName: randomUUID().slice(0, 8),
    });
    const childB = await factories.person(org, {
      firstName: 'Other',
      lastName: randomUUID().slice(0, 8),
    });
    const guardianA = newId();
    const guardianB = newId();
    for (const [id, label] of [
      [guardianA, 'a'],
      [guardianB, 'b'],
    ] as const) {
      await database
        .insertInto('accounts')
        .values({
          id,
          email: `security-guardian-${label}-${randomUUID()}@example.invalid`,
          first_name: `Guardian ${label.toUpperCase()}`,
          last_name: 'Security',
          date_of_birth: '1980-01-01',
          email_verified_at: new Date(),
        })
        .execute();
    }
    await createWithOrg(database)(org, async (trx) => {
      await trx
        .insertInto('person_account_links')
        .values([
          {
            id: newId(),
            org_id: org.orgId,
            person_id: childA,
            account_id: guardianA,
            relationship: 'guardian',
            verified_at: new Date(),
          },
          {
            id: newId(),
            org_id: org.orgId,
            person_id: childB,
            account_id: guardianB,
            relationship: 'guardian',
            verified_at: new Date(),
          },
        ])
        .execute();
    });
    const medical = createMedicalRepository(
      database,
      parseEncryptionKeys(
        JSON.stringify({ test: randomBytes(32).toString('base64') }),
        'test',
      ),
    );
    await medical.write(org.orgId, guardianB, childB, {
      expectedVersion: 0,
      allergies: 'Private child B allergy fixture',
      allergyFlags: ['peanut'],
      conditions: null,
      medications: null,
      physicianName: null,
      physicianPhone: null,
      insuranceCarrier: null,
      insurancePolicy: null,
      notes: null,
    });
    const session = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: guardianA,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        new Date(),
      ),
    );
    const api = `http://127.0.0.1:${String(3001 + offset)}/api/v1/people/me/family`;
    const headers = {
      Cookie: `__Host-athlentry_session=${session.token}`,
    };

    const family = await request.get(api, { headers });
    expect(family.status()).toBe(200);
    const familyBody = (await family.json()) as {
      organizations: Array<{ people: Array<{ personId: string }> }>;
    };
    const personIds = familyBody.organizations.flatMap((organization) =>
      organization.people.map((person) => person.personId),
    );
    expect(personIds).toContain(childA);
    expect(personIds).not.toContain(childB);

    const medicalRecord = await request.get(
      `http://127.0.0.1:${String(3001 + offset)}/api/v1/people/orgs/${org.orgId}/${childB}/medical`,
      { headers },
    );
    expect(medicalRecord.status()).toBe(404);
    expect(await medicalRecord.text()).not.toContain(
      'Private child B allergy fixture',
    );
  } finally {
    await database.destroy();
  }
});
