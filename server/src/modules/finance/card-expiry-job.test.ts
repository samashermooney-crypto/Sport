import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import type { DB } from '../../db/types.js';
import { createWithOrg, type OrgContext } from '../../db/withOrg.js';
import { FakeEmailSender } from '../../integrations/email/sender.js';

import { queueExpiringCardNotices } from './card-expiry-job.js';
import { PostgresInvoiceRepository } from './invoice-repo.js';
import { deliverFinanceNotices } from './money-notice-job.js';

let database: Kysely<DB>;
let context: OrgContext;
let expiringInstallmentId: string;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const accountId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `expiring-card-${randomUUID()}@example.invalid`,
      email_verified_at: new Date(),
      first_name: 'Expiring',
      last_name: 'Card',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `expiring-card-${randomUUID().slice(0, 12)}`,
      name: 'Card Reminder Club',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  context = { orgId, actor: { accountId } };
  const invoice = await new PostgresInvoiceRepository(database, context).issue({
    orgId,
    accountId,
    source: 'tuition',
    creationKey: randomUUID(),
    lines: [
      {
        kind: 'tuition',
        description: 'Tuition',
        amountCents: 1000,
        refundable: true,
      },
    ],
  });
  const expiringMethodId = newId();
  const validMethodId = newId();
  await database
    .insertInto('payment_methods')
    .values([
      {
        id: expiringMethodId,
        account_id: accountId,
        stripe_payment_method_id: `pm_${randomUUID()}`,
        type: 'card',
        status: 'active',
        exp_month: 9,
        exp_year: 2026,
      },
      {
        id: validMethodId,
        account_id: accountId,
        stripe_payment_method_id: `pm_${randomUUID()}`,
        type: 'card',
        status: 'active',
        exp_month: 10,
        exp_year: 2026,
      },
    ])
    .execute();
  expiringInstallmentId = newId();
  await createWithOrg(database)(context, async (trx) => {
    for (const [index, methodId] of [
      expiringMethodId,
      validMethodId,
    ].entries()) {
      await trx
        .insertInto('installments')
        .values({
          id: index === 0 ? expiringInstallmentId : newId(),
          org_id: orgId,
          invoice_id: invoice.id,
          sequence: index + 1,
          due_on: '2026-10-11',
          amount_cents: 500,
          autopay: true,
          payment_method_id: methodId,
        })
        .execute();
      await trx
        .insertInto('autopay_authorizations')
        .values({
          id: newId(),
          org_id: orgId,
          account_id: accountId,
          invoice_id: invoice.id,
          payment_method_id: methodId,
          mandate_text_version: 'test-v1',
        })
        .execute();
    }
  });
});

afterAll(async () => {
  await database.destroy();
});

describe('card expiry reminders', () => {
  it('queues once 14 org-local days before a scheduled charge and sends a pay-settings link', async () => {
    const dependencies = {
      database,
      organizationIds: [context.orgId],
      now: () => new Date('2026-09-27T16:00:00Z'),
    };
    expect(await queueExpiringCardNotices(dependencies)).toEqual({ queued: 1 });
    expect(await queueExpiringCardNotices(dependencies)).toEqual({ queued: 0 });
    const notices = await createWithOrg(database)(context, (trx) =>
      trx
        .selectFrom('finance_notice_outbox')
        .select('source_id')
        .where('org_id', '=', context.orgId)
        .where('kind', '=', 'card_expiring')
        .execute(),
    );
    expect(notices).toEqual([{ source_id: expiringInstallmentId }]);
    const sender = new FakeEmailSender();
    await deliverFinanceNotices({
      database,
      sender,
      appUrl: 'http://127.0.0.1:5173',
      organizationIds: [context.orgId],
    });
    const reminder = sender.messages.find((message) =>
      message.subject.includes('saved card will expire'),
    );
    expect(reminder?.text).toContain(
      `/portal/orgs/${context.orgId}/money/autopay`,
    );
    expect(reminder?.attachments).toBeUndefined();
  });
});
