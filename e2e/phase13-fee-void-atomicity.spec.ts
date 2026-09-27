import { expect, test } from '@playwright/test';
import { newId } from '@shared/ids';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import type { ActorFixture } from '../server/test/factories';
import { createTestFactories } from '../server/test/factories';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test.fixme('QA-ACC-046 / Track J: a rejected fee-invoice void leaves its assessment invoiced', async ({
  request,
}) => {
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  const withOrg = createWithOrg(database);
  const apiBase = `http://127.0.0.1:${String(3001 + offset)}`;
  const origin = `https://127.0.0.1:${String(5173 + offset)}`;

  const sessionFor = async (actor: ActorFixture): Promise<string> => {
    await withOrg(actor, (trx) =>
      trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute(),
    );
    const session = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: actor.accountId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        new Date(),
      ),
    );
    return session.token;
  };
  const headers = (token: string) => ({
    Cookie: `__Host-athlentry_session=${token}`,
    Origin: origin,
    'X-Athlentry-Request': '1',
    'Idempotency-Key': newId(),
  });

  try {
    const factories = createTestFactories(database);
    const league = await factories.actor();
    const club = await factories.actor();
    const leagueSession = await sessionFor(league);
    const clubSession = await sessionFor(club);
    const leagueApi = `${apiBase}/api/v1/federation/organizations/${league.orgId}`;
    const clubApi = `${apiBase}/api/v1/federation/organizations/${club.orgId}`;

    const inviteResponse = await request.post(`${leagueApi}/relationships`, {
      headers: headers(leagueSession),
      data: {
        direction: 'invite',
        organizationId: club.orgId,
        type: 'member_club',
        dataSharing: {},
      },
    });
    expect(inviteResponse.status()).toBe(201);
    const relationship = (await inviteResponse.json()) as { id: string };
    const acceptResponse = await request.post(
      `${clubApi}/relationships/${relationship.id}/accept`,
      { headers: headers(clubSession), data: {} },
    );
    expect(acceptResponse.status()).toBe(200);

    const payerResponse = await request.post(`${clubApi}/member-payers`, {
      headers: headers(clubSession),
      data: {
        leagueOrgId: league.orgId,
        billingAccountId: club.accountId,
      },
    });
    expect(payerResponse.status()).toBe(201);
    const assessmentResponse = await request.post(`${leagueApi}/fees`, {
      headers: headers(leagueSession),
      data: {
        memberOrgId: club.orgId,
        description: 'Atomicity regression fee',
        amountCents: 2500,
      },
    });
    expect(assessmentResponse.status()).toBe(201);
    const assessment = (await assessmentResponse.json()) as { id: string };
    const issueResponse = await request.post(
      `${leagueApi}/fees/${assessment.id}/issue`,
      { headers: headers(leagueSession), data: {} },
    );
    expect(issueResponse.status()).toBe(200);
    const issued = (await issueResponse.json()) as { invoiceId: string };

    await withOrg(league, (trx) =>
      trx
        .insertInto('installments')
        .values({
          id: newId(),
          org_id: league.orgId,
          invoice_id: issued.invoiceId,
          sequence: 1,
          due_on: '2026-12-01',
          amount_cents: 2500,
          status: 'scheduled',
        })
        .execute()
        .then(() => undefined),
    );

    const voidResponse = await request.post(
      `${leagueApi}/fees/${assessment.id}/void`,
      {
        headers: headers(leagueSession),
        data: { action: 'void', reason: 'Active installment fixture' },
      },
    );
    expect(voidResponse.status()).toBe(409);

    const state = await withOrg(league, (trx) =>
      trx
        .selectFrom('federation_fee_assessments as assessment')
        .innerJoin('invoices', (join) =>
          join
            .onRef('invoices.org_id', '=', 'assessment.org_id')
            .onRef('invoices.id', '=', 'assessment.invoice_id'),
        )
        .select([
          'assessment.status as assessment_status',
          'invoices.status as invoice_status',
          'invoices.balance_cents',
        ])
        .where('assessment.org_id', '=', league.orgId)
        .where('assessment.id', '=', assessment.id)
        .executeTakeFirstOrThrow(),
    );
    expect(state.assessment_status).toBe('invoiced');
    expect(state.invoice_status).not.toBe('void');
    expect(state.balance_cents).toBe(2500);
  } finally {
    await database.destroy();
  }
});
