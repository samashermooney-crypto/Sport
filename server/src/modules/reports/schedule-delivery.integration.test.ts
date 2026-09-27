import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { FakeEmailSender } from '../../integrations/email/sender';

import { deliverScheduledReports } from './schedule-delivery';
import { createReportSchedule } from './schedules';
import { createSavedReport } from './service';

const now = new Date('2026-09-27T15:00:00.000Z');
let database: ReturnType<typeof createDatabase>;
let withOrg: ReturnType<typeof createWithOrg>;

type Fixture = {
  orgId: string;
  ownerId: string;
  recipientId: string;
  reportId: string;
  scheduleId: string;
};

function context(orgId: string, accountId: string): OrgContext {
  return { orgId, actor: { accountId } };
}

async function createFixture(): Promise<Fixture> {
  const orgId = randomUUID();
  const ownerId = randomUUID();
  const recipientId = randomUUID();
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO accounts
        (id,email,first_name,last_name,date_of_birth,email_verified_at)
       VALUES ($1,$2,'Report','Owner','1980-01-01',$3),
              ($4,$5,'Report','Recipient','1980-01-01',$3)`,
      [
        ownerId,
        `${ownerId}@example.invalid`,
        now,
        recipientId,
        `${recipientId}@example.invalid`,
      ],
    );
    await admin.query(
      `INSERT INTO organizations(id,slug,name,kind,timezone,status)
       VALUES ($1,$2,'Schedule Test','club','America/Chicago','active')`,
      [orgId, `report-schedule-${orgId.slice(0, 8)}`],
    );
    for (const [accountId, role] of [
      [ownerId, 'owner'],
      [recipientId, 'finance'],
    ] as const) {
      await admin.query(
        `INSERT INTO org_memberships(id,org_id,account_id,status)
         VALUES ($1,$2,$3,'active')`,
        [randomUUID(), orgId, accountId],
      );
      await admin.query(
        `INSERT INTO role_assignments
          (id,org_id,account_id,role,scope_type,pending_mfa)
         VALUES ($1,$2,$3,$4,'org',false)`,
        [randomUUID(), orgId, accountId, role],
      );
    }
    await admin.query(
      `INSERT INTO people(id,org_id,first_name,last_name,date_of_birth)
       VALUES ($1,$2,'Morgan','Member','2012-05-15')`,
      [randomUUID(), orgId],
    );
  } finally {
    await admin.end();
  }

  const report = await createSavedReport(
    context(orgId, ownerId),
    {
      name: 'Member names',
      definition: {
        dataset: 'people',
        columns: ['first_name'],
        filters: [],
        groupBy: [],
        aggregates: [],
        sort: [],
      },
      sharedRoles: ['finance'],
    },
    withOrg,
  );
  const schedule = await createReportSchedule(
    context(orgId, ownerId),
    {
      savedReportId: report.id,
      cadence: 'daily',
      recipientAccountIds: [recipientId],
      delivery: 'csv_attachment',
      format: 'csv',
      runAtMinute: 600,
    },
    now,
    withOrg,
  );
  const adminUpdate = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await adminUpdate.connect();
  try {
    await adminUpdate.query(
      'UPDATE report_schedules SET next_run_at = $1 WHERE org_id = $2 AND id = $3',
      [new Date(now.getTime() - 60_000), orgId, schedule.id],
    );
  } finally {
    await adminUpdate.end();
  }
  return {
    orgId,
    ownerId,
    recipientId,
    reportId: report.id,
    scheduleId: schedule.id,
  };
}

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  withOrg = createWithOrg(database);
});

afterAll(async () => database.destroy());

describe('scheduled report delivery', () => {
  it('sends a safe CSV attachment through a sign-in link to a currently authorized member', async () => {
    const fixture = await createFixture();
    const sender = new FakeEmailSender();

    await expect(
      deliverScheduledReports({
        sender,
        appUrl: 'https://app.athlentry.example',
        now: () => now,
        organizationIds: [fixture.orgId],
        withOrg,
      }),
    ).resolves.toEqual({ enqueued: 1, sent: 1, suppressed: 0, failed: 0 });

    expect(sender.messages).toHaveLength(1);
    expect(sender.messages[0]?.text).toContain(
      `/console/orgs/${fixture.orgId}/reports/${fixture.reportId}`,
    );
    expect(sender.messages[0]?.idempotencyKey).toMatch(
      /^report-schedule:[0-9a-f-]+:[0-9a-f-]+$/,
    );
    expect(sender.messages[0]?.attachments?.[0]?.filename).toBe(
      'Member-names.csv',
    );
    const attachmentContent = sender.messages[0]?.attachments?.[0]?.content;
    expect(attachmentContent).toBeInstanceOf(Uint8Array);
    if (!(attachmentContent instanceof Uint8Array))
      throw new Error('Scheduled CSV attachment is missing');
    expect(new TextDecoder().decode(attachmentContent)).toContain('Morgan');
    await expect(
      withOrg(context(fixture.orgId, fixture.ownerId), async (trx) =>
        trx
          .selectFrom('report_delivery_recipients')
          .select(['status', 'account_id'])
          .where('org_id', '=', fixture.orgId)
          .where('account_id', '=', fixture.recipientId)
          .executeTakeFirstOrThrow(),
      ),
    ).resolves.toMatchObject({
      status: 'sent',
      account_id: fixture.recipientId,
    });
  });

  it('suppresses delivery when a recipient loses report access', async () => {
    const fixture = await createFixture();
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    try {
      await admin.query(
        'UPDATE role_assignments SET revoked_at = now() WHERE org_id = $1 AND account_id = $2',
        [fixture.orgId, fixture.recipientId],
      );
    } finally {
      await admin.end();
    }

    const sender = new FakeEmailSender();
    await expect(
      deliverScheduledReports({
        sender,
        appUrl: 'https://app.athlentry.example',
        now: () => now,
        organizationIds: [fixture.orgId],
        withOrg,
      }),
    ).resolves.toEqual({ enqueued: 1, sent: 0, suppressed: 1, failed: 0 });
    expect(sender.messages).toHaveLength(0);
    await expect(
      withOrg(context(fixture.orgId, fixture.ownerId), async (trx) =>
        trx
          .selectFrom('report_delivery_recipients')
          .select('status')
          .where('org_id', '=', fixture.orgId)
          .where('account_id', '=', fixture.recipientId)
          .executeTakeFirstOrThrow(),
      ),
    ).resolves.toMatchObject({ status: 'suppressed' });
  });
});
