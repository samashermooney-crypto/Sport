import { randomUUID } from 'node:crypto';

import { newId } from '@shared/ids';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely.js';
import { createWithOrg } from '../../db/withOrg.js';
import { FakeEmailSender } from '../../integrations/email/sender.js';

import { deliverRegistrationNotices } from './notice-job.js';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => {
  await database.destroy();
});

async function fixture(emailVerified: boolean) {
  const orgId = newId();
  const accountId = newId();
  const noticeId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `registration-notice-${randomUUID()}@example.invalid`,
      email_verified_at: emailVerified ? new Date() : null,
      first_name: 'Family',
      last_name: 'One',
      date_of_birth: '1990-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: `registration-notice-${randomUUID().slice(0, 10)}`,
      name: 'Registration notice test',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  await createWithOrg(database)({ orgId, actor: { accountId } }, (trx) =>
    trx
      .insertInto('registration_notice_outbox')
      .values({
        id: noticeId,
        org_id: orgId,
        account_id: accountId,
        kind: 'registration_confirmed',
        source_id: newId(),
        message_key: newId(),
        payload: {},
      })
      .execute(),
  );
  return { orgId, accountId, noticeId };
}

describe('registration notice delivery job', () => {
  it('delivers a verified family notice once through the configured fake sender', async () => {
    const { orgId, noticeId } = await fixture(true);
    const sender = new FakeEmailSender();
    const dependencies = {
      database,
      sender,
      appUrl: 'https://athlentry.example.test',
      organizationIds: [orgId],
    };

    expect(await deliverRegistrationNotices(dependencies)).toEqual({
      sent: 1,
      suppressed: 0,
    });
    expect(sender.messages).toHaveLength(1);
    const message = sender.messages[0];
    if (!message) throw new Error('Expected a delivered registration notice');
    expect(message.subject).toBe('Registration confirmed');
    expect(message.kind).toBe('transactional');
    expect(message.text.includes(`/portal/orgs/${orgId}/registrations`)).toBe(
      true,
    );
    expect(await deliverRegistrationNotices(dependencies)).toEqual({
      sent: 0,
      suppressed: 0,
    });
    const notice = await createWithOrg(database)(
      { orgId, actor: { accountId: newId() } },
      (trx) =>
        trx
          .selectFrom('registration_notice_outbox')
          .select('status')
          .where('org_id', '=', orgId)
          .where('id', '=', noticeId)
          .executeTakeFirstOrThrow(),
    );
    expect(notice.status).toBe('sent');
  });

  it('suppresses notices to accounts without verified email', async () => {
    const { orgId, noticeId } = await fixture(false);
    const sender = new FakeEmailSender();
    expect(
      await deliverRegistrationNotices({
        database,
        sender,
        appUrl: 'https://athlentry.example.test',
        organizationIds: [orgId],
      }),
    ).toEqual({ sent: 0, suppressed: 1 });
    expect(sender.messages).toHaveLength(0);
    const notice = await createWithOrg(database)(
      { orgId, actor: { accountId: newId() } },
      (trx) =>
        trx
          .selectFrom('registration_notice_outbox')
          .select('status')
          .where('org_id', '=', orgId)
          .where('id', '=', noticeId)
          .executeTakeFirstOrThrow(),
    );
    expect(notice.status).toBe('suppressed');
  });
});
