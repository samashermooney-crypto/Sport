import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import { issueSession } from '../server/src/modules/auth/sessions';
import { bindFixtureInvoice } from '../server/src/modules/checkout/test-fixtures';
import { PostgresInstallmentTemplates } from '../server/src/modules/finance/installment-templates';
import { PostgresPaymentEventRepository } from '../server/src/modules/finance/payment-event-repo';
import { PostgresPaymentRecordStore } from '../server/src/modules/finance/payment-repo';
import {
  createCampaign,
  setCampaignStatus,
} from '../server/src/modules/fundraising/service';
import { systemWorkerActorId } from '../server/src/modules/jobs/credentials-expiry';
import { adminOrderListSchema } from '../server/src/modules/store/schema';
import {
  createProduct,
  listProducts,
  listStoreOrders,
  receiveStock,
} from '../server/src/modules/store/service';
import { syncPaidTeamFees } from '../server/src/modules/team-finance/service';
import { createTestFactories } from '../server/test/factories';

import { accessibilityViolations } from './axe';

const offset = Number(process.env.PORT_OFFSET ?? '0');

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

async function createActor(database: ReturnType<typeof createDatabase>) {
  const actor = await createTestFactories(database).actor();
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
  return actor;
}

test.describe('Phase 11 acceptance', () => {
  test.setTimeout(120_000);

  test('household completes a volunteer shift, checks in, and buys out its remaining requirement', async ({
    page,
  }, testInfo) => {
    const database = createDatabase(
      `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
    );
    try {
      const factories = createTestFactories(database);
      const actor = await createActor(database);
      const program = await factories.program(actor);
      const householdId = await factories.household(actor);
      const athleteId = await factories.person(actor, {
        firstName: 'Taylor',
        lastName: 'Athlete',
        dateOfBirth: '2015-06-12',
      });
      const parentId = await factories.person(actor, {
        firstName: 'Morgan',
        lastName: 'Parent',
        dateOfBirth: '1988-02-07',
      });
      await factories.registration(actor, program, athleteId, householdId);
      const facilityId = randomUUID();
      await factories.scoped(actor, async (trx) => {
        for (const [personId, role, financiallyResponsible, relationship] of [
          [athleteId, 'athlete', true, 'guardian'],
          [parentId, 'other_adult', false, 'self'],
        ] as const) {
          await trx
            .insertInto('household_members')
            .values({
              id: randomUUID(),
              org_id: actor.orgId,
              household_id: householdId,
              person_id: personId,
              role,
              financially_responsible: financiallyResponsible,
            })
            .execute();
          await trx
            .insertInto('person_account_links')
            .values({
              id: randomUUID(),
              org_id: actor.orgId,
              person_id: personId,
              account_id: actor.accountId,
              relationship,
              verified_at: new Date(),
            })
            .execute();
        }
        await trx
          .insertInto('facilities')
          .values({
            id: facilityId,
            org_id: actor.orgId,
            name: 'Riverside Field',
            ownership: 'owned',
          })
          .execute();
      });
      await signInBrowser(page, testInfo, database, actor.accountId);
      const roleName = `Concession shift ${randomUUID().slice(0, 6)}`;
      await page.goto(`/console/orgs/${actor.orgId}/volunteers`);
      await expect(
        page.getByRole('heading', { name: 'Volunteers', exact: true }),
      ).toBeVisible();
      await page.getByLabel('Role name').fill(roleName);
      await page.getByLabel('Minimum age').fill('18');
      await page.getByRole('button', { name: 'Create role' }).click();
      await expect(
        page.getByText('Volunteer role created.', { exact: true }),
      ).toBeVisible();

      await page.getByLabel('Scope type').selectOption('program');
      await page.getByLabel('Program ID').fill(program.programId);
      await page.getByLabel('Buyout per unit in dollars').fill('50');
      await page
        .getByLabel('Count coach and team-parent shifts toward requirements')
        .check();
      await page.getByRole('button', { name: 'Create requirement' }).click();
      await expect(
        page.getByText('Volunteer requirement created.', { exact: true }),
      ).toBeVisible();
      const configuredCoachCount = await factories.scoped(actor, async (trx) =>
        trx
          .selectFrom('volunteer_requirements')
          .select('counts_coach_roles')
          .where('org_id', '=', actor.orgId)
          .where('program_id', '=', program.programId)
          .executeTakeFirstOrThrow(),
      );
      expect(configuredCoachCount.counts_coach_roles).toBe(true);

      const shiftDate = new Date(Date.now() + 8 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      await page
        .getByLabel('Volunteer role')
        .selectOption({ label: `${roleName} · age 18+` });
      await page
        .getByLabel('Shift requirement')
        .selectOption({ label: 'Fixture League · 2 shifts' });
      await page.getByLabel('Facility ID').fill(facilityId);
      await page.getByLabel('Shift date').fill(shiftDate);
      await page.getByLabel('Starts at').fill('09:00');
      await page.getByLabel('Ends at').fill('11:00');
      await page.getByRole('button', { name: 'Create shift' }).click();
      await expect(
        page.getByText('Volunteer shift created.', { exact: true }),
      ).toBeVisible();

      await page.goto(`/me/orgs/${actor.orgId}/volunteers`);
      await expect(
        page.getByRole('heading', { name: 'Volunteer shifts' }),
      ).toBeVisible();
      expect(await accessibilityViolations(page)).toEqual([]);
      await page.getByLabel('Household member').selectOption(parentId);
      await page
        .getByRole('button', { name: `Sign up for ${roleName}` })
        .click();
      await expect(
        page.getByText(`Signed up Morgan Parent for ${roleName}.`, {
          exact: true,
        }),
      ).toBeVisible();

      await page.goto(`/console/orgs/${actor.orgId}/volunteers`);
      await expect(
        page.getByRole('heading', { name: 'Volunteers', exact: true }),
      ).toBeVisible();
      expect(await accessibilityViolations(page)).toEqual([]);
      await page.getByRole('button', { name: 'View signups' }).click();
      await page.getByRole('button', { name: 'Check in' }).click();
      await expect(
        page.getByText('Morgan Parent marked checked in.', { exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Complete & credit' }).click();
      await expect(
        page.getByText('Morgan Parent marked completed.', { exact: true }),
      ).toBeVisible();

      await page.goto(`/me/orgs/${actor.orgId}/volunteers`);
      await expect(
        page.getByText(/1 of 2 shifts complete · 1 remaining/),
      ).toBeVisible();
      await page
        .getByRole('button', { name: 'Buy out remaining shifts' })
        .click();
      await expect(
        page.getByText('Buyout invoice created for $50.00.', { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(/2 of 2 shifts complete · 0 remaining/),
      ).toBeVisible();
      expect(await accessibilityViolations(page)).toEqual([]);
    } finally {
      await database.destroy();
    }
  });

  test('team finances issue three installments, record the first payment, and approve a treasurer reimbursement', async ({
    page,
  }, testInfo) => {
    const database = createDatabase(
      `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
    );
    try {
      const factories = createTestFactories(database);
      const actor = await createActor(database);
      const program = await factories.program(actor);
      const team = await factories.team(actor, program);
      const householdId = await factories.household(actor);
      const athleteId = await factories.person(actor, {
        firstName: 'Jamie',
        lastName: 'Player',
      });
      const treasurerId = await factories.person(actor, {
        firstName: 'Jordan',
        lastName: 'Treasurer',
        dateOfBirth: '1985-03-03',
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
          .insertInto('person_account_links')
          .values({
            id: randomUUID(),
            org_id: actor.orgId,
            person_id: treasurerId,
            account_id: actor.accountId,
            relationship: 'self',
            verified_at: new Date(),
          })
          .execute();
        await trx
          .insertInto('team_staff')
          .values({
            id: randomUUID(),
            org_id: actor.orgId,
            team_season_id: team.teamSeasonId,
            person_id: treasurerId,
            role: 'treasurer',
            status: 'active',
            added_by: actor.accountId,
          })
          .execute();
        await trx
          .insertInto('roster_entries')
          .values({
            id: randomUUID(),
            org_id: actor.orgId,
            team_season_id: team.teamSeasonId,
            person_id: athleteId,
            registration_id: registrationId,
            status: 'active',
          })
          .execute();
      });
      const template = await new PostgresInstallmentTemplates(
        database,
        actor,
      ).create({
        name: `Three team installments ${randomUUID().slice(0, 6)}`,
        deposit: { kind: 'fixed', amountCents: 0 },
        schedule: {
          kind: 'fixed_dates',
          dates: ['2026-11-01', '2026-12-01', '2027-01-01'],
        },
        minAmountCents: 15_000,
        autopayRequired: false,
        allowedMethods: ['card'],
      });

      await signInBrowser(page, testInfo, database, actor.accountId);
      await page.goto(`/console/orgs/${actor.orgId}/team-finance`);
      await expect(
        page.getByRole('heading', { name: 'Team finance', exact: true }),
      ).toBeVisible();
      expect(await accessibilityViolations(page)).toEqual([]);
      await page.getByLabel('Per-player fee in dollars').fill('450');
      await page.getByLabel('Due date').fill('2026-11-01');
      await page
        .getByLabel('Installment schedule')
        .selectOption({ label: template.name });
      await page.getByRole('button', { name: 'Create assessment' }).click();
      await expect(page.getByRole('status')).toContainText(
        'Team fee assessment created.',
      );
      await page.getByRole('button', { name: 'Issue family invoices' }).click();
      await expect(page.getByRole('status')).toContainText(
        '1 family invoice issued.',
      );

      const withOrg = createWithOrg(database);
      const assessment = await withOrg(actor, async (trx) =>
        trx
          .selectFrom('team_fee_assessments')
          .select('id')
          .where('org_id', '=', actor.orgId)
          .where('team_season_id', '=', team.teamSeasonId)
          .orderBy('created_at', 'desc')
          .executeTakeFirstOrThrow(),
      );
      const invoice = await withOrg(actor, async (trx) =>
        trx
          .selectFrom('team_fee_obligations')
          .select('invoice_id')
          .where('org_id', '=', actor.orgId)
          .where('assessment_id', '=', assessment.id)
          .executeTakeFirstOrThrow(),
      );
      const firstInstallment = await withOrg(actor, async (trx) =>
        trx
          .selectFrom('installments')
          .select(['id', 'amount_cents'])
          .where('org_id', '=', actor.orgId)
          .where('invoice_id', '=', invoice.invoice_id)
          .orderBy('sequence')
          .executeTakeFirstOrThrow(),
      );
      expect(firstInstallment.amount_cents).toBe(15_000);

      await page.goto(`/portal/orgs/${actor.orgId}/money/invoices`);
      await expect(page.getByText('$450.00', { exact: true })).toHaveCount(2);
      await expect(
        page.getByText('$450.00', { exact: true }).first(),
      ).toBeVisible();
      expect(await accessibilityViolations(page)).toEqual([]);

      const checkoutId = randomUUID();
      const paymentIntentId = `pi_phase11_${randomUUID()}`;
      await withOrg(actor, (trx) =>
        trx
          .insertInto('checkouts')
          .values({
            id: checkoutId,
            org_id: actor.orgId,
            account_id: actor.accountId,
            status: 'awaiting_payment',
            expires_at: new Date(Date.now() + 86_400_000),
            pricing_snapshot: { totalCents: 15_000 },
          })
          .execute(),
      );
      await bindFixtureInvoice(database, actor, checkoutId, invoice.invoice_id);
      await new PostgresPaymentRecordStore(database, actor).recordPending({
        orgId: actor.orgId,
        checkoutId,
        invoiceId: invoice.invoice_id,
        accountId: actor.accountId,
        paymentIntentId,
        amountCents: 15_000,
        applicationFeeCents: 0,
        idempotencyKey: randomUUID(),
      });
      const payment = await withOrg(actor, async (trx) =>
        trx
          .selectFrom('payments')
          .select('id')
          .where('org_id', '=', actor.orgId)
          .where('stripe_payment_intent_id', '=', paymentIntentId)
          .executeTakeFirstOrThrow(),
      );
      await withOrg(actor, (trx) =>
        trx
          .updateTable('payment_allocations')
          .set({ installment_id: firstInstallment.id })
          .where('org_id', '=', actor.orgId)
          .where('payment_id', '=', payment.id)
          .execute(),
      );
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
          amountCents: 15_000,
          latestChargeId: `ch_${randomUUID()}`,
          method: 'card',
        },
      });
      await syncPaidTeamFees(database, actor.orgId);

      await page.goto(`/me/orgs/${actor.orgId}/team-finance`);
      await expect(
        page.getByRole('heading', { name: 'Team finances' }),
      ).toBeVisible();
      await expect(page.getByText('Income $150.00')).toBeVisible();
      expect(await accessibilityViolations(page)).toEqual([]);
      const receiptFileId = randomUUID();
      await factories.row(actor, 'files', {
        id: receiptFileId,
        org_id: actor.orgId,
        purpose: 'document',
        storage_key: `phase11-receipt/${receiptFileId}`,
        mime: 'application/pdf',
        bytes: 128,
        sensitivity: 'internal',
        created_by: actor.accountId,
        upload_state: 'complete',
        expires_at: new Date('2030-01-01T00:00:00.000Z'),
      });
      await page.route('**/api/v1/files/uploads', (route) =>
        route.fulfill({
          status: 201,
          json: { fileId: receiptFileId, uploadUrl: '/phase11-receipt-upload' },
        }),
      );
      await page.route('**/phase11-receipt-upload', (route) =>
        route.fulfill({ status: 204 }),
      );
      await page.route(
        `**/api/v1/files/uploads/${receiptFileId}/complete`,
        (route) => route.fulfill({ json: { id: receiptFileId } }),
      );
      await page.getByLabel('Category').fill('Tournament travel');
      await page.getByLabel('Amount in dollars').fill('75');
      await page.locator('input[type="file"]').setInputFiles({
        name: 'receipt.pdf',
        mimeType: 'application/pdf',
        buffer: Buffer.from('%PDF-1.4 phase11 test receipt'),
      });
      await page
        .getByLabel('Business purpose')
        .fill('Travel to the regional tournament');
      await page.getByRole('button', { name: 'Submit for approval' }).click();
      await expect(page.getByRole('status')).toContainText(
        'Reimbursement submitted for club finance review.',
      );

      await page.goto(`/console/orgs/${actor.orgId}/team-finance`);
      await expect(page.getByText('$75.00 · Tournament travel')).toBeVisible();
      await page.getByRole('button', { name: 'Approve' }).click();
      await expect(page.getByRole('status')).toContainText(
        'Reimbursement approved.',
      );
      await expect(
        page
          .getByRole('region', { name: 'Team balances' })
          .getByRole('heading', { name: 'Balance', exact: true })
          .locator('..'),
      ).toContainText('$75.00');
      expect(await accessibilityViolations(page)).toEqual([]);
    } finally {
      await database.destroy();
    }
  });

  test('family submits a ship-to address and store staff can read it for fulfillment', async ({
    page,
  }, testInfo) => {
    const database = createDatabase(
      `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
    );
    try {
      const factories = createTestFactories(database);
      const actor = await createActor(database);
      const householdId = await factories.household(actor);
      const athleteId = await factories.person(actor, {
        firstName: 'Casey',
        lastName: 'Uniform',
      });
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
      });
      const productName = `Travel jersey ${randomUUID().slice(0, 6)}`;
      const productId = await createProduct(database, actor, {
        name: productName,
        kind: 'uniform',
        requiredForRegistration: false,
        variants: [
          {
            sku: `SHIP-${randomUUID().slice(0, 8)}`,
            size: 'Youth Large',
            priceCents: 3_500,
          },
        ],
      });
      const variantId = (await listProducts(database, actor)).find(
        (product) => product.id === productId,
      )?.variants[0]?.id;
      if (!variantId) throw new Error('Created jersey variant was not listed');
      await receiveStock(database, actor, variantId, 1);

      await signInBrowser(page, testInfo, database, actor.accountId);
      await page.goto(`/me/orgs/${actor.orgId}/store`);
      await expect(
        page.getByRole('heading', { name: 'Uniforms and spirit wear' }),
      ).toBeVisible();
      expect(await accessibilityViolations(page)).toEqual([]);
      await page.getByLabel('Fulfillment').selectOption('ship');
      await page
        .getByLabel('Shipping address line 1')
        .fill('44 Tournament Way');
      await page.getByLabel('Shipping address line 2').fill('Unit 5');
      await page.getByLabel('Shipping city').fill('Madison');
      await page.getByLabel('Shipping state').fill('wi');
      await page.getByLabel('Shipping ZIP code').fill('53704');
      await page.getByLabel(`${productName} size`).selectOption(variantId);
      await page.getByLabel('Quantity').fill('1');
      await page
        .getByRole('button', { name: 'Place order and create invoice' })
        .click();
      await expect(page.getByText(/Order created\./)).toBeVisible();
      expect(await accessibilityViolations(page)).toEqual([]);
      adminOrderListSchema.parse({
        orders: await listStoreOrders(database, actor),
      });

      const storeApiFailures: string[] = [];
      page.on('response', async (response) => {
        if (
          response.url().includes('/api/v1/store/') &&
          response.status() >= 400
        ) {
          storeApiFailures.push(
            `${String(response.status())} ${response.url()}: ${await response.text()}`,
          );
        }
      });
      await page.goto(`/console/orgs/${actor.orgId}/store`);
      await expect(
        page.getByRole('heading', { name: 'Store inventory' }),
      ).toBeVisible();
      expect(storeApiFailures).toEqual([]);
      await expect(
        page
          .getByRole('list', { name: 'Store orders' })
          .getByText('Ship to: 44 Tournament Way, Unit 5, Madison, WI 53704'),
      ).toBeVisible();
      expect(storeApiFailures).toEqual([]);
      expect(await accessibilityViolations(page)).toEqual([]);
    } finally {
      await database.destroy();
    }
  });

  test('guest donates $300 to a team fundraiser and receives the nonprofit acknowledgment', async ({
    page,
    request,
  }, testInfo) => {
    const database = createDatabase(
      `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
    );
    try {
      const factories = createTestFactories(database);
      const actor = await createActor(database);
      const program = await factories.program(actor);
      const team = await factories.team(actor, program);
      const slug = `team-travel-${randomUUID().slice(0, 8)}`;
      const campaignId = await createCampaign(database, actor, {
        name: 'Team travel fund',
        slug,
        goalCents: 100_000,
        startsAt: new Date(Date.now() - 60_000).toISOString(),
        teamSeasonId: team.teamSeasonId,
        descriptionHtml: '<p>Help the team reach the regional tournament.</p>',
        showDonorNames: true,
      });
      await setCampaignStatus(database, actor, campaignId, {
        status: 'published',
        expectedVersion: 1,
      });
      await signInBrowser(page, testInfo, database, actor.accountId);
      await page.goto(`/console/orgs/${actor.orgId}/fundraising`);
      await expect(
        page.getByRole('heading', { name: 'Campaigns and donations' }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Team travel fund' }),
      ).toBeVisible();
      await page.getByLabel('Organization is a nonprofit').check();
      await expect(page.getByLabel('Nine-digit EIN')).toBeVisible();
      await page.getByLabel('Nine-digit EIN').fill('123456789');
      await page
        .getByRole('button', { name: 'Save acknowledgment settings' })
        .click();
      await expect(page.getByRole('status')).toContainText(
        'Donation acknowledgment settings saved.',
      );
      const acknowledgmentSettings = await createWithOrg(database)(
        actor,
        (trx) =>
          trx
            .selectFrom('fundraising_settings')
            .select(['is_nonprofit', 'show_full_ein'])
            .where('org_id', '=', actor.orgId)
            .executeTakeFirstOrThrow(),
      );
      expect(acknowledgmentSettings).toEqual({
        is_nonprofit: true,
        show_full_ein: false,
      });
      expect(await accessibilityViolations(page)).toEqual([]);
      const orgSlug = await createWithOrg(database)(actor, async (trx) =>
        trx
          .selectFrom('organizations')
          .select('slug')
          .where('id', '=', actor.orgId)
          .executeTakeFirstOrThrow()
          .then((row) => row.slug),
      );
      const donorEmail = `phase11-${randomUUID()}@example.test`;

      await page.goto(`/site/${orgSlug}/fundraisers/${slug}`);
      await expect(
        page.getByRole('heading', { name: 'Team travel fund' }),
      ).toBeVisible();
      expect(await accessibilityViolations(page)).toEqual([]);
      await page.getByLabel('Your name').fill('Riley Donor');
      await page.getByLabel('Email address').fill(donorEmail);
      await page.getByLabel('Donation amount in dollars').fill('300');
      await page.getByLabel('Keep my donation anonymous').uncheck();
      await page
        .getByRole('button', { name: 'Continue to secure checkout' })
        .click();
      await expect(page).toHaveURL(/status=success$/, { timeout: 30_000 });
      await expect(page.getByRole('status')).toContainText(
        'Donation complete. Thank you for supporting this team.',
      );
      await expect(page.getByText(/Raised\s+\$300\.00/)).toBeVisible();
      await expect(page.getByText('Riley Donor')).toBeVisible();
      expect(await accessibilityViolations(page)).toEqual([]);

      let receiptText = '';
      await expect
        .poll(
          async () => {
            const mailbox = await request.get(
              `http://127.0.0.1:${String(8025 + offset)}/api/v1/messages`,
            );
            const summary = (await mailbox.json()) as {
              messages: Array<{
                ID: string;
                To: Array<{ Address: string }>;
              }>;
            };
            const message = summary.messages.find((item) =>
              item.To.some((recipient) => recipient.Address === donorEmail),
            );
            if (!message) return '';
            const detailResponse = await request.get(
              `http://127.0.0.1:${String(8025 + offset)}/api/v1/message/${message.ID}`,
            );
            const detail = (await detailResponse.json()) as { Text: string };
            receiptText = detail.Text;
            return receiptText;
          },
          { timeout: 30_000 },
        )
        .not.toBe('');
      expect(receiptText).toContain('EIN ends in 6789');
      expect(receiptText).toContain(
        'No goods or services were provided in exchange for this contribution.',
      );
      expect(receiptText).not.toContain('123456789');
    } finally {
      await database.destroy();
    }
  });
});
