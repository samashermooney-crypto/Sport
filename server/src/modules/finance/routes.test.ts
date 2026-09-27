import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { Temporal } from '@js-temporal/polyfill';
import { newId } from '@shared/ids';
import express from 'express';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import type { PaymentsGateway } from '../../integrations/stripe/gateway.js';
import type { AuthDependencies } from '../auth/routes.js';
import { bindFixtureInvoice } from '../checkout/test-fixtures.js';

import { aidProgramSchema } from './aid-programs.js';
import { creditBalanceSchema } from './credit-balances.js';
import { PostgresInvoiceRepository } from './invoice-repo.js';
import { PostgresPaymentEventRepository } from './payment-event-repo.js';
import { PostgresPaymentRecordStore } from './payment-repo.js';
import {
  aidAwardResponseSchema,
  createFinanceRouter,
  payoutJournalResponseSchema,
  refundResponseSchema,
  staffCreditIssueResponseSchema,
} from './routes.js';
import { taxRateSchema } from './tax-rates.js';
import { yearEndStatementSchema } from './year-end-statements.js';

const origin = 'http://127.0.0.1:5173';
const now = new Date('2026-09-27T12:00:00Z');
let database: Kysely<DB>;
let context: OrgContext;
let paymentId: string;
let token: string;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
const createRefund = vi
  .fn()
  .mockResolvedValue({ id: 're_route', status: 'pending', amountCents: 500 });
const createCustomer = vi.fn().mockResolvedValue({ id: 'cus_route' });
const createSetupIntent = vi.fn().mockResolvedValue({
  id: 'seti_route',
  clientSecret: 'seti_route_secret_test',
});
const listPaymentMethods = vi.fn().mockResolvedValue([
  {
    id: 'pm_route',
    type: 'card',
    brand: 'visa',
    last4: '4242',
    expMonth: 12,
    expYear: 2030,
    bankName: null,
  },
]);
const setDefaultPaymentMethod = vi.fn().mockResolvedValue(undefined);
const detachPaymentMethod = vi.fn().mockResolvedValue(undefined);
const createExpressAccount = vi.fn().mockResolvedValue({ id: 'acct_route' });
const createAccountLink = vi.fn().mockResolvedValue({
  url: 'https://connect.stripe.com/onboard/test',
});
const createExpressLoginLink = vi.fn().mockResolvedValue({
  url: 'https://dashboard.stripe.com/express/test',
});
const retrieveAccount = vi.fn().mockResolvedValue({
  id: 'acct_route',
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  requirements: {
    currentlyDue: ['business_profile.url'],
    disabledReason: null,
  },
});

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  const checkoutId = newId();
  const paymentIntentId = `pi_${randomUUID()}`;
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `refund-route-${randomUUID()}@example.invalid`,
      first_name: 'Refund',
      last_name: 'Route',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `refund-route-${randomUUID().slice(0, 12)}`,
      name: 'Refund Route',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  await createWithOrg(database)(context, async (trx) => {
    await trx
      .insertInto('org_memberships')
      .values({
        id: newId(),
        org_id: orgId,
        account_id: accountId,
        status: 'active',
        joined_at: now,
      })
      .execute();
    await trx
      .insertInto('role_assignments')
      .values({
        id: newId(),
        org_id: orgId,
        account_id: accountId,
        role: 'finance',
        scope_type: 'org',
        pending_mfa: false,
      })
      .execute();
  });
  const invoice = await new PostgresInvoiceRepository(database, context).issue({
    orgId,
    accountId,
    source: 'checkout',
    creationKey: randomUUID(),
    refundTerms: {
      policy: {
        rules: [],
        afterLastBps: 5000,
        serviceFeeRefund: 'proportional',
      },
      approvalThresholdCents: 500,
      refundApplicationFee: true,
    },
    lines: [
      {
        kind: 'registration',
        description: 'Registration',
        amountCents: 1000,
        refundable: true,
      },
    ],
  });
  await createWithOrg(database)(context, (trx) =>
    trx
      .insertInto('checkouts')
      .values({
        id: checkoutId,
        org_id: orgId,
        account_id: accountId,
        status: 'awaiting_payment',
        expires_at: new Date('2027-01-01T00:00:00Z'),
        pricing_snapshot: { totalCents: 1000 },
      })
      .execute(),
  );
  await bindFixtureInvoice(database, context, checkoutId, invoice.id);
  await new PostgresPaymentRecordStore(database, context).recordPending({
    orgId,
    checkoutId,
    invoiceId: invoice.id,
    accountId,
    paymentIntentId,
    amountCents: 1000,
    applicationFeeCents: 10,
    idempotencyKey: randomUUID(),
  });
  await new PostgresPaymentEventRepository(database, accountId, () =>
    Temporal.Instant.from(now.toISOString()),
  ).applyLatest({
    orgId,
    paymentIntentId,
    latest: {
      id: paymentIntentId,
      clientSecret: null,
      status: 'succeeded',
      amountCents: 1000,
      latestChargeId: `ch_${randomUUID()}`,
      method: 'card',
    },
  });
  paymentId = (
    await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('payments')
        .select('id')
        .where('org_id', '=', orgId)
        .where('stripe_payment_intent_id', '=', paymentIntentId)
        .executeTakeFirstOrThrow(),
    )
  ).id;
  token = randomBytes(32).toString('base64url');
  await database
    .insertInto('sessions')
    .values({
      id: newId(),
      account_id: accountId,
      token_hash: createHash('sha256').update(token).digest(),
      kind: 'cookie',
      client: 'web',
      privileged: false,
      idle_expires_at: new Date(now.getTime() + 60 * 60 * 1000),
      absolute_expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    })
    .execute();
  const app = express();
  app.use(
    '/api/v1/finance',
    createFinanceRouter(
      {
        database,
        appUrl: origin,
        clock: () => now,
      } as AuthDependencies,
      () =>
        ({
          createRefund,
          createCustomer,
          createSetupIntent,
          listPaymentMethods,
          setDefaultPaymentMethod,
          detachPaymentMethod,
          createExpressAccount,
          createAccountLink,
          createExpressLoginLink,
          retrieveAccount,
        }) as unknown as PaymentsGateway,
    ),
  );
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/finance`;
});

afterAll(async () => {
  server.close();
  await database.destroy();
});

function request(
  idempotencyKey: string,
  requestOrigin = origin,
): Promise<Response> {
  return fetch(`${baseUrl}/orgs/${context.orgId}/refunds`, {
    method: 'POST',
    headers: {
      Cookie: `__Host-athlentry_session=${token}`,
      Origin: requestOrigin,
      'X-Athlentry-Request': '1',
      'Idempotency-Key': idempotencyKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      destination: 'original_method',
      paymentId,
      cancellationDate: '2026-09-27',
    }),
  });
}

describe('staff invoice HTTP', () => {
  it('requires finance origin, dedupes the issue key, and rejects a changed replay', async () => {
    const key = randomUUID();
    const body = {
      accountId: context.actor.accountId,
      refundTerms: {
        policy: {
          rules: [],
          afterLastBps: 5000,
          serviceFeeRefund: 'proportional',
        },
        approvalThresholdCents: 500,
        refundApplicationFee: true,
      },
      lines: [
        {
          kind: 'team_fee',
          description: 'Season fee',
          amountCents: 2500,
          refundable: true,
        },
      ],
    };
    const post = (payload: unknown, originHeader = origin) =>
      fetch(`${baseUrl}/orgs/${context.orgId}/invoices`, {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${token}`,
          Origin: originHeader,
          'X-Athlentry-Request': '1',
          'Idempotency-Key': key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    expect((await post(body, 'https://attacker.example')).status).toBe(403);
    expect((await post({ ...body, accountId: newId() })).status).toBe(403);
    expect((await post({ ...body, householdId: newId() })).status).toBe(403);
    const first = await post(body);
    expect(first.status).toBe(201);
    const created = (await first.json()) as { id: string; totalCents: number };
    expect(created.totalCents).toBe(2500);
    const replay = await post(body);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({ id: created.id });
    expect((await post({ ...body, memo: 'changed' })).status).toBe(409);
    const stored = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('invoices')
        .select(['source', 'refund_terms'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', created.id)
        .executeTakeFirstOrThrow(),
    );
    expect(stored.source).toBe('staff');
    expect(stored.refund_terms).toMatchObject(body.refundTerms);
    const invoicePath = `${baseUrl}/orgs/${context.orgId}/invoices/${created.id}`;
    const detailResponse = await fetch(invoicePath, {
      headers: { Cookie: `__Host-athlentry_session=${token}` },
    });
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as {
      version: number;
      lines: { amountCents: number }[];
    };
    expect(detail.lines.map((line) => line.amountCents)).toEqual([2500]);
    const voidInvoice = (reason: string, expectedVersion = detail.version) =>
      fetch(`${invoicePath}/void`, {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${token}`,
          Origin: origin,
          'X-Athlentry-Request': '1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason, expectedVersion }),
      });
    expect((await voidInvoice('Canceled', detail.version + 1)).status).toBe(
      409,
    );
    expect((await voidInvoice('Canceled')).status).toBe(200);
    expect((await voidInvoice('Canceled')).status).toBe(200);
    expect((await voidInvoice('Different reason')).status).toBe(409);
    const voided = await fetch(invoicePath, {
      headers: { Cookie: `__Host-athlentry_session=${token}` },
    });
    expect(await voided.json()).toMatchObject({
      status: 'void',
      voidReason: 'Canceled',
    });
  });
});

describe('payer year-end statement HTTP', () => {
  it('returns only the signed-in account money for the requested org year', async () => {
    const response = await fetch(
      `${baseUrl}/orgs/${context.orgId}/me/statements/2026`,
      {
        headers: { Cookie: `__Host-athlentry_session=${token}` },
      },
    );
    expect(response.status).toBe(200);
    expect(
      yearEndStatementSchema.parse((await response.json()) as unknown),
    ).toMatchObject({
      orgId: context.orgId,
      year: 2026,
      currency: 'USD',
      totalPaidCents: 1000,
      donationPaidCents: 0,
    });
  });
});

describe('product tax rate HTTP', () => {
  it('creates a product-only rate and replaces it at an exact version', async () => {
    const path = `${baseUrl}/orgs/${context.orgId}/tax-rates`;
    const key = randomUUID();
    const create = (requestOrigin: string) =>
      fetch(path, {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${token}`,
          Origin: requestOrigin,
          'X-Athlentry-Request': '1',
          'Idempotency-Key': key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Merchandise tax',
          rateBps: 700,
          active: true,
        }),
      });
    expect((await create('https://attacker.example')).status).toBe(403);
    const created = await create(origin);
    expect(created.status).toBe(201);
    const rate = taxRateSchema.parse((await created.json()) as unknown);
    expect(rate.appliesTo).toBe('products');
    expect(
      taxRateSchema.parse((await (await create(origin)).json()) as unknown),
    ).toEqual(rate);
    const replace = await fetch(`${path}/${rate.id}`, {
      method: 'PUT',
      headers: {
        Cookie: `__Host-athlentry_session=${token}`,
        Origin: origin,
        'X-Athlentry-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: rate.name,
        rateBps: 750,
        active: true,
        expectedVersion: rate.version,
      }),
    });
    expect(replace.status).toBe(200);
    expect(taxRateSchema.parse((await replace.json()) as unknown).rateBps).toBe(
      750,
    );
    const list = await fetch(path, {
      headers: {
        Cookie: `__Host-athlentry_session=${token}`,
      },
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      taxRates: [
        expect.objectContaining({
          id: rate.id,
          rateBps: 750,
        }),
      ],
    });
  });
});

describe('payer credit balance HTTP', () => {
  it('issues linked account credit and applies it to the payer invoice once', async () => {
    const bill = await new PostgresInvoiceRepository(database, context).issue({
      orgId: context.orgId,
      accountId: context.actor.accountId,
      source: 'staff',
      creationKey: randomUUID(),
      lines: [
        {
          kind: 'team_fee',
          description: 'Team fee',
          amountCents: 300,
          refundable: true,
        },
      ],
    });
    const issueKey = randomUUID();
    const issuePath = `${baseUrl}/orgs/${context.orgId}/credits`;
    const postIssue = (requestOrigin: string) =>
      fetch(issuePath, {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${token}`,
          Origin: requestOrigin,
          'X-Athlentry-Request': '1',
          'Idempotency-Key': issueKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipient: { kind: 'account', accountId: context.actor.accountId },
          amountCents: 200,
          source: 'goodwill',
          expiresOn: null,
        }),
      });
    expect((await postIssue('https://attacker.example')).status).toBe(403);
    const issued = await postIssue(origin);
    expect(issued.status).toBe(201);
    const firstIssue = staffCreditIssueResponseSchema.parse(
      (await issued.json()) as unknown,
    );
    const replayIssue = await postIssue(origin);
    expect(replayIssue.status).toBe(201);
    expect(
      staffCreditIssueResponseSchema.parse(
        (await replayIssue.json()) as unknown,
      ),
    ).toEqual(firstIssue);
    const unlinkedAccountId = newId();
    await database
      .insertInto('accounts')
      .values({
        id: unlinkedAccountId,
        email: `unlinked-credit-${randomUUID()}@example.invalid`,
        first_name: 'Unlinked',
        last_name: 'Payer',
        date_of_birth: '1990-01-01',
      })
      .execute();
    const unlinked = await fetch(issuePath, {
      method: 'POST',
      headers: {
        Cookie: `__Host-athlentry_session=${token}`,
        Origin: origin,
        'X-Athlentry-Request': '1',
        'Idempotency-Key': randomUUID(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipient: { kind: 'account', accountId: unlinkedAccountId },
        amountCents: 200,
        source: 'goodwill',
        expiresOn: null,
      }),
    });
    expect(unlinked.status).toBe(403);
    const applyKey = randomUUID();
    const applyPath = `${baseUrl}/orgs/${context.orgId}/me/credits/apply`;
    const postApply = (amountCents = 200) =>
      fetch(applyPath, {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${token}`,
          Origin: origin,
          'X-Athlentry-Request': '1',
          'Idempotency-Key': applyKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          recipient: { kind: 'account' },
          invoiceId: bill.id,
          amountCents,
        }),
      });
    expect((await postApply()).status).toBe(200);
    expect((await postApply()).status).toBe(200);
    expect((await postApply(199)).status).toBe(409);
    const invoice = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('invoices')
        .select(['credit_applied_cents', 'balance_cents'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', bill.id)
        .executeTakeFirstOrThrow(),
    );
    expect(invoice).toMatchObject({
      credit_applied_cents: 200,
      balance_cents: 100,
    });
  });
  it('returns only the signed-in account scope', async () => {
    const response = await fetch(
      `${baseUrl}/orgs/${context.orgId}/me/credits`,
      {
        headers: { Cookie: `__Host-athlentry_session=${token}` },
      },
    );
    expect(response.status).toBe(200);
    const balance = creditBalanceSchema.parse(
      (await response.json()) as unknown,
    );
    expect(balance.orgId).toBe(context.orgId);
    expect(balance.accountBalanceCents).toBeGreaterThanOrEqual(0);
  });
});

describe('payer invoice feed', () => {
  it('lists only the signed-in account invoices in one org', async () => {
    const otherAccountId = newId();
    await database
      .insertInto('accounts')
      .values({
        id: otherAccountId,
        email: `payer-feed-${randomUUID()}@example.invalid`,
        first_name: 'Other',
        last_name: 'Payer',
        date_of_birth: '1990-01-01',
      })
      .execute();
    const otherInvoice = await new PostgresInvoiceRepository(
      database,
      context,
    ).issue({
      orgId: context.orgId,
      accountId: otherAccountId,
      source: 'staff',
      creationKey: randomUUID(),
      lines: [
        {
          kind: 'team_fee',
          description: 'Other fee',
          amountCents: 700,
          refundable: true,
        },
      ],
    });
    const response = await fetch(
      `${baseUrl}/orgs/${context.orgId}/me/invoices`,
      { headers: { Cookie: `__Host-athlentry_session=${token}` } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      invoices: { id: string; balanceCents: number }[];
      nextBeforeNumber: number | null;
    };
    expect(body.invoices.length).toBeGreaterThan(0);
    expect(
      body.invoices.some((invoice) => invoice.id === otherInvoice.id),
    ).toBe(false);
    expect(body.invoices.every((invoice) => invoice.balanceCents >= 0)).toBe(
      true,
    );
    expect(body.nextBeforeNumber).toBeNull();
  });
});

describe('aid award HTTP', () => {
  it('lists only review metadata and declines at the submitted version', async () => {
    const seasonId = newId();
    const householdId = newId();
    const aidProgramId = newId();
    const applicationId = newId();
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('seasons')
        .values({
          id: seasonId,
          org_id: context.orgId,
          name: 'Review API season',
          starts_on: '2026-01-01',
          ends_on: '2027-12-31',
        })
        .execute();
      await trx
        .insertInto('households')
        .values({
          id: householdId,
          org_id: context.orgId,
          name: 'Review family',
        })
        .execute();
      await trx
        .insertInto('financial_aid_programs')
        .values({
          id: aidProgramId,
          org_id: context.orgId,
          name: 'Review fund',
          season_id: seasonId,
          budget_cents: 200,
          status: 'open',
        })
        .execute();
      await trx
        .insertInto('aid_applications')
        .values({
          id: applicationId,
          org_id: context.orgId,
          financial_aid_program_id: aidProgramId,
          household_id: householdId,
          requested_cents: 200,
          status: 'submitted',
        })
        .execute();
    });
    const path = `${baseUrl}/orgs/${context.orgId}/aid-applications`;
    const queue = await fetch(`${path}?seasonId=${seasonId}`, {
      headers: { Cookie: `__Host-athlentry_session=${token}` },
    });
    expect(queue.status).toBe(200);
    const listing = await queue.text();
    expect(listing).toContain(applicationId);
    expect(listing).not.toContain('answers');
    const post = (requestOrigin: string) =>
      fetch(`${path}/${applicationId}/decision`, {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${token}`,
          Origin: requestOrigin,
          'X-Athlentry-Request': '1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expectedVersion: 1,
          action: 'decline',
          reason: 'incomplete_application',
        }),
      });
    expect((await post('https://attacker.example')).status).toBe(403);
    const declined = await post(origin);
    expect(declined.status).toBe(200);
    expect(await declined.json()).toMatchObject({
      applicationId,
      status: 'declined',
      version: 2,
    });
    expect((await post(origin)).status).toBe(409);
  });
  it('creates and opens an aid fund only for a finance session', async () => {
    const seasonId = newId();
    const formId = newId();
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('seasons')
        .values({
          id: seasonId,
          org_id: context.orgId,
          name: 'Aid API season',
          starts_on: '2026-01-01',
          ends_on: '2027-12-31',
        })
        .execute();
      await trx
        .insertInto('form_definitions')
        .values({
          id: formId,
          org_id: context.orgId,
          name: 'Aid API form',
          scope: 'custom',
          schema: {},
          published_at: now,
        })
        .execute();
    });
    const path = `${baseUrl}/orgs/${context.orgId}/aid-programs`;
    const key = randomUUID();
    const post = (requestOrigin: string) =>
      fetch(path, {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${token}`,
          Origin: requestOrigin,
          'X-Athlentry-Request': '1',
          'Idempotency-Key': key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Aid API fund',
          seasonId,
          applicationFormId: formId,
          budgetCents: 1000,
        }),
      });
    expect((await post('https://attacker.example')).status).toBe(403);
    const created = await post(origin);
    expect(created.status).toBe(201);
    const fund = aidProgramSchema.parse((await created.json()) as unknown);
    expect(
      aidProgramSchema.parse((await (await post(origin)).json()) as unknown),
    ).toEqual(fund);
    const replace = await fetch(`${path}/${fund.id}`, {
      method: 'PUT',
      headers: {
        Cookie: `__Host-athlentry_session=${token}`,
        Origin: origin,
        'X-Athlentry-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: fund.name,
        applicationFormId: formId,
        budgetCents: 1000,
        expectedVersion: fund.version,
        status: 'open',
      }),
    });
    expect(replace.status).toBe(200);
    expect(
      aidProgramSchema.parse((await replace.json()) as unknown).status,
    ).toBe('open');
    const list = await fetch(`${path}?seasonId=${seasonId}`, {
      headers: { Cookie: `__Host-athlentry_session=${token}` },
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      programs: [
        expect.objectContaining({
          id: fund.id,
          status: 'open',
        }),
      ],
    });
  });
  it('reserves one budgeted decision for a finance actor and replays the exact key', async () => {
    const seasonId = newId();
    const householdId = newId();
    const aidProgramId = newId();
    const applicationId = newId();
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('seasons')
        .values({
          id: seasonId,
          org_id: context.orgId,
          name: 'Aid season',
          starts_on: '2026-01-01',
          ends_on: '2027-12-31',
        })
        .execute();
      await trx
        .insertInto('households')
        .values({
          id: householdId,
          org_id: context.orgId,
          name: 'Aid household',
        })
        .execute();
      await trx
        .insertInto('financial_aid_programs')
        .values({
          id: aidProgramId,
          org_id: context.orgId,
          name: 'Aid fund',
          season_id: seasonId,
          budget_cents: 500,
          status: 'open',
        })
        .execute();
      await trx
        .insertInto('aid_applications')
        .values({
          id: applicationId,
          org_id: context.orgId,
          financial_aid_program_id: aidProgramId,
          household_id: householdId,
          requested_cents: 500,
          status: 'under_review',
        })
        .execute();
    });
    const key = randomUUID();
    const path = `${baseUrl}/orgs/${context.orgId}/aid-applications/${applicationId}/award`;
    const post = (requestOrigin: string, idempotencyKey = key) =>
      fetch(path, {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${token}`,
          Origin: requestOrigin,
          'X-Athlentry-Request': '1',
          'Idempotency-Key': idempotencyKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expectedVersion: 1,
          decision: { kind: 'fixed', amountCents: 500 },
        }),
      });
    expect((await post('https://attacker.example')).status).toBe(403);
    const first = await post(origin);
    expect(first.status).toBe(200);
    const body = aidAwardResponseSchema.parse((await first.json()) as unknown);
    expect(body).toMatchObject({
      applicationId,
      status: 'awarded',
      awardCents: 500,
    });
    const replay = await post(origin);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(body);
    expect((await post(origin, randomUUID())).status).toBe(409);
  });
});

describe('staff refund HTTP', () => {
  it('rejects cross-origin writes, records an approved-threshold refund and replays it', async () => {
    const key = randomUUID();
    expect((await request(key, 'https://attacker.example')).status).toBe(403);
    expect(createRefund).not.toHaveBeenCalled();
    const first = await request(key);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({
      destination: 'original_method',
      refundId: 're_route',
      amountCents: 500,
    });
    const replay = await request(key);
    expect(replay.status).toBe(201);
    expect(createRefund).toHaveBeenCalledTimes(1);
  });

  it('requires a different stepped-up finance account for an above-threshold refund', async () => {
    createRefund.mockResolvedValue({
      id: 're_route_second',
      status: 'pending',
      amountCents: 500,
    });
    const requesterId = context.actor.accountId;
    const approverId = newId();
    const approverToken = randomBytes(32).toString('base64url');
    await database
      .insertInto('accounts')
      .values({
        id: approverId,
        email: `refund-approver-${randomUUID()}@example.invalid`,
        first_name: 'Second',
        last_name: 'Approver',
        date_of_birth: '1990-01-01',
      })
      .execute();
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('org_memberships')
        .values({
          id: newId(),
          org_id: context.orgId,
          account_id: approverId,
          status: 'active',
          joined_at: now,
        })
        .execute();
      await trx
        .insertInto('role_assignments')
        .values({
          id: newId(),
          org_id: context.orgId,
          account_id: approverId,
          role: 'finance',
          scope_type: 'org',
          pending_mfa: false,
        })
        .execute();
    });
    const approverSessionId = newId();
    await database
      .insertInto('sessions')
      .values({
        id: approverSessionId,
        account_id: approverId,
        token_hash: createHash('sha256').update(approverToken).digest(),
        kind: 'cookie',
        client: 'web',
        privileged: false,
        idle_expires_at: new Date(now.getTime() + 60 * 60 * 1000),
        absolute_expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      })
      .execute();
    const invoice = await new PostgresInvoiceRepository(
      database,
      context,
    ).issue({
      orgId: context.orgId,
      accountId: requesterId,
      source: 'checkout',
      creationKey: randomUUID(),
      refundTerms: {
        policy: {
          rules: [],
          afterLastBps: 5000,
          serviceFeeRefund: 'proportional',
        },
        approvalThresholdCents: 400,
        refundApplicationFee: true,
      },
      lines: [
        {
          kind: 'registration',
          description: 'Registration',
          amountCents: 1000,
          refundable: true,
        },
      ],
    });
    const checkoutId = newId();
    const paymentIntentId = `pi_${randomUUID()}`;
    await createWithOrg(database)(context, (trx) =>
      trx
        .insertInto('checkouts')
        .values({
          id: checkoutId,
          org_id: context.orgId,
          account_id: requesterId,
          status: 'awaiting_payment',
          expires_at: new Date('2027-01-01T00:00:00Z'),
          pricing_snapshot: { totalCents: 1000 },
        })
        .execute(),
    );
    await bindFixtureInvoice(database, context, checkoutId, invoice.id);
    await new PostgresPaymentRecordStore(database, context).recordPending({
      orgId: context.orgId,
      checkoutId,
      invoiceId: invoice.id,
      accountId: requesterId,
      paymentIntentId,
      amountCents: 1000,
      applicationFeeCents: 10,
      idempotencyKey: randomUUID(),
    });
    await new PostgresPaymentEventRepository(database, requesterId, () =>
      Temporal.Instant.from(now.toISOString()),
    ).applyLatest({
      orgId: context.orgId,
      paymentIntentId,
      latest: {
        id: paymentIntentId,
        clientSecret: null,
        status: 'succeeded',
        amountCents: 1000,
        latestChargeId: `ch_${randomUUID()}`,
        method: 'card',
      },
    });
    const secondPaymentId = (
      await createWithOrg(database)(context, (trx) =>
        trx
          .selectFrom('payments')
          .select('id')
          .where('org_id', '=', context.orgId)
          .where('stripe_payment_intent_id', '=', paymentIntentId)
          .executeTakeFirstOrThrow(),
      )
    ).id;
    const key = randomUUID();
    const body = JSON.stringify({
      destination: 'original_method',
      paymentId: secondPaymentId,
      cancellationDate: '2026-09-27',
    });
    const post = (path: string, sessionToken: string, withBody = true) =>
      fetch(`${baseUrl}/orgs/${context.orgId}/${path}`, {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${sessionToken}`,
          Origin: origin,
          'X-Athlentry-Request': '1',
          'Idempotency-Key': key,
          'Content-Type': 'application/json',
        },
        ...(withBody ? { body } : {}),
      });
    expect((await post('refunds', token)).status).toBe(409);
    const requested = await post('refund-approvals', token);
    expect(requested.status).toBe(201);
    const approval = (await requested.json()) as {
      id: string;
      status: string;
      amountCents: number;
    };
    expect(approval).toMatchObject({ status: 'pending', amountCents: 500 });
    const approvalPath = `refund-approvals/${approval.id}/approve`;
    expect((await post(approvalPath, token, false)).status).toBe(403);
    expect((await post(approvalPath, approverToken, false)).status).toBe(403);
    await database
      .updateTable('sessions')
      .set({ elevated_until: new Date(now.getTime() + 15 * 60 * 1000) })
      .where('id', '=', approverSessionId)
      .execute();
    expect((await post(approvalPath, approverToken, false)).status).toBe(200);
    const executed = await post('refunds', token);
    const executedBody = refundResponseSchema.parse(
      (await executed.json()) as unknown,
    );
    expect(executed.status, JSON.stringify(executedBody)).toBe(201);
    expect(executedBody).toMatchObject({
      amountCents: 500,
      refundId: 're_route_second',
    });
    expect((await post('refunds', token)).status).toBe(201);
    expect(createRefund).toHaveBeenCalledTimes(2);
  });
});

describe('finance payout journal HTTP', () => {
  it('returns a balanced CSV only for an authorized reconciled payout', async () => {
    const payoutId = `po_${randomUUID().replaceAll('-', '')}`;
    const transactionId = `txn_${randomUUID().replaceAll('-', '')}`;
    const chargeId = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('payments')
        .select('stripe_charge_id')
        .where('org_id', '=', context.orgId)
        .where('id', '=', paymentId)
        .executeTakeFirstOrThrow(),
    );
    if (!chargeId.stripe_charge_id)
      throw new Error('Payment charge is missing');
    await createWithOrg(database)(context, async (trx) => {
      await trx
        .insertInto('payouts')
        .values({
          id: newId(),
          org_id: context.orgId,
          stripe_payout_id: payoutId,
          amount_cents: 970,
          arrival_date: '2026-09-27',
          status: 'paid',
          balance_transaction_ids: [transactionId],
        })
        .execute();
      await trx
        .insertInto('balance_transactions')
        .values({
          id: newId(),
          org_id: context.orgId,
          stripe_balance_transaction_id: transactionId,
          stripe_payout_id: payoutId,
          type: 'charge',
          amount_cents: 1000,
          fee_cents: 30,
          net_cents: 970,
          source_id: chargeId.stripe_charge_id,
        })
        .execute();
    });
    const response = await fetch(
      `${baseUrl}/orgs/${context.orgId}/payouts/${payoutId}/journal-export`,
      {
        method: 'POST',
        headers: {
          Cookie: `__Host-athlentry_session=${token}`,
          Origin: origin,
          'X-Athlentry-Request': '1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bank: '1000',
          stripeClearing: '1010',
          processingFees: '6200',
          transactionTypes: { charge: '4000' },
        }),
      },
    );
    expect(response.status).toBe(200);
    const result = payoutJournalResponseSchema.parse(
      (await response.json()) as unknown,
    );
    expect(result.lineCount).toBe(5);
    expect(result.csv).toContain('Date,Journal No,Account,Debits,Credits');
    expect(result.csv).toContain('9.70');
  });
});

describe('signed-in payer method HTTP', () => {
  it('creates one test SetupIntent and manages only payer-attached methods', async () => {
    const headers = {
      Cookie: `__Host-athlentry_session=${token}`,
      Origin: origin,
      'X-Athlentry-Request': '1',
      'Idempotency-Key': randomUUID(),
    };
    const blocked = await fetch(`${baseUrl}/me/setup-intents`, {
      method: 'POST',
      headers: { ...headers, Origin: 'https://attacker.example' },
    });
    expect(blocked.status).toBe(403);
    const setup = await fetch(`${baseUrl}/me/setup-intents`, {
      method: 'POST',
      headers,
    });
    expect(setup.status).toBe(201);
    expect(await setup.json()).toMatchObject({
      id: 'seti_route',
      clientSecret: 'seti_route_secret_test',
    });
    expect(createCustomer).toHaveBeenCalledTimes(1);
    const listed = await fetch(`${baseUrl}/me/payment-methods`, {
      headers: { Cookie: headers.Cookie },
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      methods: [{ id: 'pm_route', last4: '4242' }],
    });
    const defaulted = await fetch(
      `${baseUrl}/me/payment-methods/pm_route/default`,
      {
        method: 'POST',
        headers,
      },
    );
    expect(defaulted.status).toBe(200);
    expect(setDefaultPaymentMethod).toHaveBeenCalledWith(
      'cus_route',
      'pm_route',
    );
    const afterDefault = await fetch(`${baseUrl}/me/payment-methods`, {
      headers: { Cookie: headers.Cookie },
    });
    expect(await afterDefault.json()).toMatchObject({
      defaultMethodId: 'pm_route',
    });
    const removed = await fetch(`${baseUrl}/me/payment-methods/pm_route`, {
      method: 'DELETE',
      headers,
    });
    expect(removed.status).toBe(200);
    expect(detachPaymentMethod).toHaveBeenCalledWith('pm_route');
  });
});

describe('Connect Express finance HTTP', () => {
  it('creates onboarding, surfaces requirements and gates the dashboard', async () => {
    const path = `${baseUrl}/orgs/${context.orgId}/connect`;
    const headers = {
      Cookie: `__Host-athlentry_session=${token}`,
      Origin: origin,
      'X-Athlentry-Request': '1',
    };
    const empty = await fetch(`${path}/status`, {
      headers: { Cookie: headers.Cookie },
    });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ stripeAccountId: null });
    const start = await fetch(`${path}/onboarding`, {
      method: 'POST',
      headers,
    });
    expect(start.status).toBe(201);
    expect(await start.json()).toEqual({
      url: 'https://connect.stripe.com/onboard/test',
    });
    expect(createExpressAccount).toHaveBeenCalledTimes(1);
    const linkArgs = createAccountLink.mock.calls[0]?.[0] as unknown as {
      accountId: string;
      returnUrl: string;
      refreshUrl: string;
    };
    expect(linkArgs.accountId).toBe('acct_route');
    expect(linkArgs.returnUrl).toContain('/money/connect/return');
    expect(linkArgs.refreshUrl).toContain('/money/connect/refresh');
    const status = await fetch(`${path}/status`, {
      headers: { Cookie: headers.Cookie },
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      stripeAccountId: 'acct_route',
      chargesEnabled: false,
      requirementsDue: ['business_profile.url'],
    });
    expect(
      (await fetch(`${path}/dashboard`, { method: 'POST', headers })).status,
    ).toBe(409);
    retrieveAccount.mockResolvedValue({
      id: 'acct_route',
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requirements: { currentlyDue: [], disabledReason: null },
    });
    const dashboard = await fetch(`${path}/dashboard`, {
      method: 'POST',
      headers,
    });
    expect(dashboard.status).toBe(200);
    expect(await dashboard.json()).toEqual({
      url: 'https://dashboard.stripe.com/express/test',
    });
    expect(createExpressLoginLink).toHaveBeenCalledWith('acct_route');
  });
});

describe('installment template finance HTTP', () => {
  it('restricts writes and versions create, replace and archive for the offering picker', async () => {
    const path = `${baseUrl}/orgs/${context.orgId}/installment-templates`;
    const headers = {
      Cookie: `__Host-athlentry_session=${token}`,
      Origin: origin,
      'X-Athlentry-Request': '1',
      'Content-Type': 'application/json',
    };
    const body = {
      name: 'Monthly registration plan',
      deposit: { kind: 'percent', bps: 2500 },
      schedule: { kind: 'monthly', count: 3, dayOfMonth: 15 },
      minAmountCents: 100,
      autopayRequired: true,
      allowedMethods: ['card', 'us_bank_account'],
    };
    expect(
      (
        await fetch(path, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://attacker.example' },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(403);
    const created = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    expect(created.status).toBe(201);
    const template = (await created.json()) as { id: string; version: number };
    expect(template.version).toBe(1);
    const listed = await fetch(path, { headers: { Cookie: headers.Cookie } });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ templates: [body] });
    const updated = await fetch(`${path}/${template.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'If-Match': '1' },
      body: JSON.stringify({ ...body, name: 'Updated plan' }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      version: 2,
      name: 'Updated plan',
    });
    expect(
      (
        await fetch(`${path}/${template.id}`, {
          method: 'PATCH',
          headers: { ...headers, 'If-Match': '1' },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await fetch(`${path}/${template.id}`, {
          method: 'DELETE',
          headers: { ...headers, 'If-Match': '2' },
        })
      ).status,
    ).toBe(200);
    expect(
      await (await fetch(path, { headers: { Cookie: headers.Cookie } })).json(),
    ).toEqual({ templates: [] });
  });
});
