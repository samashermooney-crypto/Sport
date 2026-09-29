import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { bindFixtureInvoice } from '../server/src/modules/checkout/test-fixtures';
import { PostgresPaymentEventRepository } from '../server/src/modules/finance/payment-event-repo';
import { PostgresPaymentRecordStore } from '../server/src/modules/finance/payment-repo';
import { systemWorkerActorId } from '../server/src/modules/jobs/credentials-expiry';
import {
  createProduct,
  listProducts,
  listStoreOrders,
  receiveStock,
  reconcilePaidStoreOrders,
  uniformSizeReport,
} from '../server/src/modules/store/service';
import { createTestFactories } from '../server/test/factories';

import { e2eDatabaseUrl } from './database';


async function signInBrowser(
  page: import('@playwright/test').Page,
  testInfo: import('@playwright/test').TestInfo,
  database: ReturnType<typeof createDatabase>,
  accountId: string,
) {
  const session = await database.transaction().execute((trx) =>
    issueSession(
      trx,
      {
        accountId,
        kind: 'cookie',
        client: 'web',
        privileged: false,
      },
      new Date(),
    ),
  );
  await page.context().addCookies([
    {
      name: '__Host-athlentry_session',
      value: session.token,
      url: String(testInfo.project.use.baseURL),
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await page.addInitScript(() => {
    localStorage.setItem('athlentry-language', 'en');
  });
}

test('QA-ACC-038 / Track H: family uniform orders appear under their registration team and program', async ({
  page,
}, testInfo) => {
  const database = createDatabase(
    e2eDatabaseUrl('app'),
  );
  try {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const withOrg = createWithOrg(database);
    await withOrg(actor, async (trx) => {
      await trx
        .updateTable('organizations')
        .set({ status: 'active' })
        .where('id', '=', actor.orgId)
        .execute();
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', actor.orgId)
        .where('account_id', '=', actor.accountId)
        .execute();
    });
    const program = await factories.program(actor);
    const team = await factories.team(actor, program);
    const householdId = await factories.household(actor);
    const athleteId = await factories.person(actor, {
      firstName: 'Taylor',
      lastName: 'Uniform',
      dateOfBirth: '2015-06-12',
    });
    const registrationId = await factories.registration(
      actor,
      program,
      athleteId,
      householdId,
    );
    await factories.scoped(actor, async (trx) => {
      await trx
        .insertInto('household_members')
        .values({
          id: randomUUID(),
          org_id: actor.orgId,
          household_id: householdId,
          person_id: athleteId,
          role: 'athlete',
          financially_responsible: true,
        })
        .execute();
      await trx
        .insertInto('person_account_links')
        .values({
          id: randomUUID(),
          org_id: actor.orgId,
          person_id: athleteId,
          account_id: actor.accountId,
          relationship: 'guardian',
          verified_at: new Date(),
        })
        .execute();
      await trx
        .updateTable('registrations')
        .set({ team_season_id: team.teamSeasonId })
        .where('org_id', '=', actor.orgId)
        .where('id', '=', registrationId)
        .execute();
    });

    const productName = `Team uniform ${randomUUID().slice(0, 6)}`;
    const productId = await createProduct(database, actor, {
      name: productName,
      kind: 'uniform',
      requiredForRegistration: true,
      variants: [
        {
          sku: `TEAM-${randomUUID().slice(0, 8)}`,
          size: 'Youth Medium',
          priceCents: 4_500,
        },
      ],
    });
    const variantId = (await listProducts(database, actor)).find(
      (product) => product.id === productId,
    )?.variants[0]?.id;
    if (!variantId) throw new Error('Created uniform variant was not listed');
    await receiveStock(database, actor, variantId, 2);

    await signInBrowser(page, testInfo, database, actor.accountId);
    await page.goto(`/me/orgs/${actor.orgId}/store`);
    await expect(
      page.getByRole('heading', { name: 'Uniforms and spirit wear' }),
    ).toBeVisible();
    await page.getByLabel('Household member').selectOption(athleteId);
    await page.getByLabel(`${productName} size`).selectOption(variantId);
    await page.getByLabel('Quantity').fill('1');
    await page
      .getByRole('button', { name: 'Place order and create invoice' })
      .click();
    await expect(page.getByText(/Order created\./)).toBeVisible();

    const order = (await listStoreOrders(database, actor))[0];
    if (!order?.invoiceId) throw new Error('Uniform invoice was not issued');
    const checkoutId = randomUUID();
    const paymentIntentId = `pi_uniform_${randomUUID()}`;
    const amountCents = order.subtotalCents + order.taxCents;
    await withOrg(actor, (trx) =>
      trx
        .insertInto('checkouts')
        .values({
          id: checkoutId,
          org_id: actor.orgId,
          account_id: actor.accountId,
          status: 'awaiting_payment',
          expires_at: new Date(Date.now() + 86_400_000),
          pricing_snapshot: { totalCents: amountCents },
        })
        .execute(),
    );
    await bindFixtureInvoice(database, actor, checkoutId, order.invoiceId);
    await new PostgresPaymentRecordStore(database, actor).recordPending({
      orgId: actor.orgId,
      checkoutId,
      invoiceId: order.invoiceId,
      accountId: actor.accountId,
      paymentIntentId,
      amountCents,
      applicationFeeCents: 0,
      idempotencyKey: randomUUID(),
    });
    await new PostgresPaymentEventRepository(
      database,
      systemWorkerActorId,
    ).applyLatest({
      orgId: actor.orgId,
      paymentIntentId,
      latest: {
        id: paymentIntentId,
        clientSecret: null,
        status: 'succeeded',
        amountCents,
        latestChargeId: `ch_${randomUUID()}`,
        method: 'card',
      },
    });
    expect(await reconcilePaidStoreOrders(database, actor)).toBe(1);

    await expect(
      uniformSizeReport(database, actor, {
        teamSeasonId: team.teamSeasonId,
        programId: program.programId,
      }),
    ).resolves.toEqual([
      {
        teamSeasonId: team.teamSeasonId,
        productName,
        size: 'Youth Medium',
        quantity: 1,
      },
    ]);
  } finally {
    await database.destroy();
  }
});
