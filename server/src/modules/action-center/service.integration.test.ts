import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import { loadActionCenter, runActionCenterReminder } from './service';

const orgId = randomUUID();
const ownerId = randomUUID();
let database: ReturnType<typeof createDatabase>;
let withOrg: ReturnType<typeof createWithOrg>;

const context = (accountId: string): OrgContext => ({
  orgId,
  actor: { accountId },
});

beforeAll(async () => {
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    await admin.query(
      'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
      [ownerId, `${ownerId}@example.invalid`, 'Action', 'Owner', '1980-01-01'],
    );
    await admin.query(
      'INSERT INTO organizations(id,slug,name,kind,timezone,status) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        orgId,
        `actions-${orgId.slice(0, 8)}`,
        'Action Center Test',
        'club',
        'UTC',
        'active',
      ],
    );
    await admin.query(
      'INSERT INTO org_memberships(id,org_id,account_id,status) VALUES ($1,$2,$3,$4)',
      [randomUUID(), orgId, ownerId, 'active'],
    );
    await admin.query(
      'INSERT INTO role_assignments(id,org_id,account_id,role,scope_type,pending_mfa) VALUES ($1,$2,$3,$4,$5,false)',
      [randomUUID(), orgId, ownerId, 'owner', 'org'],
    );
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  withOrg = createWithOrg(database);
});

afterAll(async () => database.destroy());

describe('action center', () => {
  it('queries every role-visible source and omits empty queues', async () => {
    await expect(
      loadActionCenter(
        context(ownerId),
        withOrg,
        new Date('2026-09-28T12:00:00Z'),
      ),
    ).resolves.toEqual({ cards: [] });
  });

  it('conceals organization queues from accounts without active membership', async () => {
    await expect(
      loadActionCenter(
        context(randomUUID()),
        withOrg,
        new Date('2026-09-28T12:00:00Z'),
      ),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('restricts finance reminder actions to finance-capable roles', async () => {
    const communicationsId = randomUUID();
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    try {
      await admin.query(
        'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
        [
          communicationsId,
          `${communicationsId}@example.invalid`,
          'Casey',
          'Comms',
          '1980-01-01',
        ],
      );
      await admin.query(
        'INSERT INTO org_memberships(id,org_id,account_id,status) VALUES ($1,$2,$3,$4)',
        [randomUUID(), orgId, communicationsId, 'active'],
      );
      await admin.query(
        `INSERT INTO role_assignments(id,org_id,account_id,role,scope_type,pending_mfa)
         VALUES ($1,$2,$3,'communications','org',false)`,
        [randomUUID(), orgId, communicationsId],
      );

      await expect(
        runActionCenterReminder(
          context(communicationsId),
          'past_due_reminders',
          withOrg,
          new Date('2026-09-28T12:00:00Z'),
        ),
      ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    } finally {
      await admin.query(
        'DELETE FROM role_assignments WHERE account_id=$1 AND org_id=$2',
        [communicationsId, orgId],
      );
      await admin.query(
        'DELETE FROM org_memberships WHERE account_id=$1 AND org_id=$2',
        [communicationsId, orgId],
      );
      await admin.query('DELETE FROM accounts WHERE id=$1', [communicationsId]);
      await admin.end();
    }
  });

  it('links unread website submissions to the working contact inbox', async () => {
    const submissionId = randomUUID();
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    try {
      await admin.query(
        `INSERT INTO contact_submissions(id,org_id,name,email,subject,body)
         VALUES ($1,$2,'Jordan Parent','jordan@example.invalid','Question','Can you share the schedule?')`,
        [submissionId, orgId],
      );
      const result = await loadActionCenter(
        context(ownerId),
        withOrg,
        new Date('2026-09-28T12:00:00Z'),
      );
      expect(result.cards).toContainEqual(
        expect.objectContaining({
          id: 'unread-contacts',
          count: 1,
          href: `/console/orgs/${orgId}/website/contacts`,
          actionLabel: 'Open contact inbox',
          bulkAction: 'mark_contacts_read',
        }),
      );
    } finally {
      await admin.query('DELETE FROM contact_submissions WHERE id = $1', [
        submissionId,
      ]);
      await admin.end();
    }
  });

  it('keeps communications queues out of the finance role view', async () => {
    const communicationsId = randomUUID();
    const financeId = randomUUID();
    const submissionId = randomUUID();
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    try {
      for (const [accountId, role] of [
        [communicationsId, 'communications'],
        [financeId, 'finance'],
      ] as const) {
        await admin.query(
          `INSERT INTO accounts(id,email,first_name,last_name,date_of_birth)
           VALUES ($1,$2,'Action','Role','1980-01-01')`,
          [accountId, `${accountId}@example.invalid`],
        );
        await admin.query(
          'INSERT INTO org_memberships(id,org_id,account_id,status) VALUES ($1,$2,$3,$4)',
          [randomUUID(), orgId, accountId, 'active'],
        );
        await admin.query(
          `INSERT INTO role_assignments(id,org_id,account_id,role,scope_type,pending_mfa)
           VALUES ($1,$2,$3,$4,'org',false)`,
          [randomUUID(), orgId, accountId, role],
        );
      }
      await admin.query(
        `INSERT INTO contact_submissions(id,org_id,name,email,subject,body)
         VALUES ($1,$2,'Jordan Parent','jordan@example.invalid','Question','Can you share the schedule?')`,
        [submissionId, orgId],
      );

      const communications = await loadActionCenter(
        context(communicationsId),
        withOrg,
        new Date('2026-09-28T12:00:00Z'),
      );
      expect(communications.cards).toContainEqual(
        expect.objectContaining({ id: 'unread-contacts', count: 1 }),
      );

      const finance = await loadActionCenter(
        context(financeId),
        withOrg,
        new Date('2026-09-28T12:00:00Z'),
      );
      expect(finance.cards.some(({ id }) => id === 'unread-contacts')).toBe(
        false,
      );
    } finally {
      await admin.query('DELETE FROM contact_submissions WHERE id = $1', [
        submissionId,
      ]);
      await admin.query(
        'DELETE FROM role_assignments WHERE account_id = ANY($1::uuid[])',
        [[communicationsId, financeId]],
      );
      await admin.query(
        'DELETE FROM org_memberships WHERE account_id = ANY($1::uuid[])',
        [[communicationsId, financeId]],
      );
      await admin.query('DELETE FROM accounts WHERE id = ANY($1::uuid[])', [
        [communicationsId, financeId],
      ]);
      await admin.end();
    }
  });

  it('sends one in-app reminder per overdue invoice and skips unread duplicates', async () => {
    const accountId = randomUUID();
    const invoiceId = randomUUID();
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    try {
      await admin.query(
        'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
        [
          accountId,
          `${accountId}@example.invalid`,
          'Taylor',
          'Family',
          '1985-01-01',
        ],
      );
      await admin.query(
        'INSERT INTO org_memberships(id,org_id,account_id,status) VALUES ($1,$2,$3,$4)',
        [randomUUID(), orgId, accountId, 'active'],
      );
      await admin.query('BEGIN');
      await admin.query(
        `INSERT INTO invoices(id,org_id,number,account_id,status,source,subtotal_cents,total_cents,due_on)
         VALUES ($1,$2,1,$3,'past_due','staff',2500,2500,'2026-09-01')`,
        [invoiceId, orgId, accountId],
      );
      await admin.query(
        `INSERT INTO invoice_lines(id,org_id,invoice_id,kind,description,quantity,unit_amount_cents,amount_cents)
         VALUES ($1,$2,$3,'adjustment','Action Center test balance',1,2500,2500)`,
        [randomUUID(), orgId, invoiceId],
      );
      await admin.query('COMMIT');

      const now = new Date('2026-09-28T12:00:00Z');
      await expect(
        runActionCenterReminder(
          context(ownerId),
          'past_due_reminders',
          withOrg,
          now,
        ),
      ).resolves.toEqual({ sentCount: 1, skippedCount: 0 });
      await expect(
        runActionCenterReminder(
          context(ownerId),
          'past_due_reminders',
          withOrg,
          now,
        ),
      ).resolves.toEqual({ sentCount: 0, skippedCount: 1 });

      const notifications = await admin.query<{
        account_id: string;
        delivered_channels: string[];
        payload: Record<string, unknown>;
        type: string;
      }>(
        `SELECT account_id,type,payload,delivered_channels FROM notifications
         WHERE org_id=$1 AND type='finance.payment_due' AND payload->>'resourceId'=$2`,
        [orgId, invoiceId],
      );
      expect(notifications.rows).toHaveLength(1);
      expect(notifications.rows[0]?.account_id).toBe(accountId);
      expect(notifications.rows[0]?.type).toBe('finance.payment_due');
      expect(notifications.rows[0]?.delivered_channels).toEqual(['in_app']);
      expect(notifications.rows[0]?.payload).toEqual({
        resourceType: 'invoice',
        resourceId: invoiceId,
        href: `/portal/orgs/${orgId}/money/invoices`,
      });
    } finally {
      await admin.end();
    }
  });

  it('notifies the invoice account about a failed autopay without retrying a charge', async () => {
    const accountId = randomUUID();
    const invoiceId = randomUUID();
    const installmentId = randomUUID();
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    try {
      await admin.query(
        'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
        [
          accountId,
          `${accountId}@example.invalid`,
          'Jordan',
          'Family',
          '1985-01-01',
        ],
      );
      await admin.query(
        'INSERT INTO org_memberships(id,org_id,account_id,status) VALUES ($1,$2,$3,$4)',
        [randomUUID(), orgId, accountId, 'active'],
      );
      await admin.query('BEGIN');
      await admin.query(
        `INSERT INTO invoices(id,org_id,number,account_id,status,source,subtotal_cents,total_cents,due_on)
         VALUES ($1,$2,2,$3,'open','staff',2500,2500,'2026-09-01')`,
        [invoiceId, orgId, accountId],
      );
      await admin.query(
        `INSERT INTO invoice_lines(id,org_id,invoice_id,kind,description,quantity,unit_amount_cents,amount_cents)
         VALUES ($1,$2,$3,'adjustment','Action Center test balance',1,2500,2500)`,
        [randomUUID(), orgId, invoiceId],
      );
      await admin.query('COMMIT');
      await admin.query(
        `INSERT INTO installments(id,org_id,invoice_id,sequence,due_on,amount_cents,autopay,status,updated_at)
         VALUES ($1,$2,$3,1,'2026-09-01',2500,true,'failed','2026-09-28T10:00:00Z')`,
        [installmentId, orgId, invoiceId],
      );

      await expect(
        runActionCenterReminder(
          context(ownerId),
          'failed_installment_contacts',
          withOrg,
          new Date('2026-09-28T12:00:00Z'),
        ),
      ).resolves.toEqual({ sentCount: 1, skippedCount: 0 });

      const notification = await admin.query<{
        account_id: string;
        delivered_channels: string[];
        payload: Record<string, unknown>;
      }>(
        `SELECT account_id,payload,delivered_channels FROM notifications
         WHERE org_id=$1 AND type='installment.failed' AND payload->>'resourceId'=$2`,
        [orgId, installmentId],
      );
      expect(notification.rows).toHaveLength(1);
      expect(notification.rows[0]?.account_id).toBe(accountId);
      expect(notification.rows[0]?.delivered_channels).toEqual(['in_app']);
      expect(notification.rows[0]?.payload).toEqual({
        resourceType: 'installment',
        resourceId: installmentId,
        href: `/portal/orgs/${orgId}/money/installments`,
      });
      const installment = await admin.query<{ attempt_count: number }>(
        'SELECT attempt_count FROM installments WHERE org_id=$1 AND id=$2',
        [orgId, installmentId],
      );
      expect(installment.rows[0]?.attempt_count).toBe(0);
    } finally {
      await admin.end();
    }
  });

  it('sends staff compliance reminders only to a verified self-linked staff account', async () => {
    const sportProfileId = randomUUID();
    const seasonId = randomUUID();
    const programId = randomUUID();
    const divisionId = randomUUID();
    const teamId = randomUUID();
    const teamSeasonId = randomUUID();
    const personId = randomUUID();
    const staffAccountId = randomUUID();
    const guardianAccountId = randomUUID();
    const staffId = randomUUID();
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    try {
      await admin.query(
        'INSERT INTO sport_profiles(id,org_id,name,profile) VALUES ($1,$2,$3,$4)',
        [sportProfileId, orgId, 'Reminder Soccer', JSON.stringify({})],
      );
      await admin.query(
        'INSERT INTO seasons(id,org_id,name,starts_on,ends_on) VALUES ($1,$2,$3,$4,$5)',
        [seasonId, orgId, 'Reminder Season', '2026-01-01', '2026-12-31'],
      );
      await admin.query(
        `INSERT INTO programs(id,org_id,season_id,sport_profile_id,mode,name,slug,starts_on,ends_on)
         VALUES ($1,$2,$3,$4,'league','Reminder Program',$5,'2026-03-01','2026-11-30')`,
        [
          programId,
          orgId,
          seasonId,
          sportProfileId,
          `reminder-${programId.slice(0, 8)}`,
        ],
      );
      await admin.query(
        'INSERT INTO divisions(id,org_id,program_id,name) VALUES ($1,$2,$3,$4)',
        [divisionId, orgId, programId, 'Reminder Division'],
      );
      await admin.query(
        'INSERT INTO teams(id,org_id,name,sport_profile_id) VALUES ($1,$2,$3,$4)',
        [teamId, orgId, 'Reminder Team', sportProfileId],
      );
      await admin.query(
        'INSERT INTO team_seasons(id,org_id,team_id,program_id,division_id) VALUES ($1,$2,$3,$4,$5)',
        [teamSeasonId, orgId, teamId, programId, divisionId],
      );
      await admin.query(
        'INSERT INTO people(id,org_id,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
        [personId, orgId, 'Morgan', 'Coach', '1985-01-01'],
      );
      for (const accountId of [staffAccountId, guardianAccountId]) {
        await admin.query(
          'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
          [
            accountId,
            `${accountId}@example.invalid`,
            'Morgan',
            'Coach',
            '1985-01-01',
          ],
        );
        await admin.query(
          'INSERT INTO org_memberships(id,org_id,account_id,status) VALUES ($1,$2,$3,$4)',
          [randomUUID(), orgId, accountId, 'active'],
        );
      }
      await admin.query(
        `INSERT INTO person_account_links(id,org_id,person_id,account_id,relationship,verified_at)
         VALUES ($1,$2,$3,$4,'self',now()),($5,$2,$3,$6,'guardian',now())`,
        [
          randomUUID(),
          orgId,
          personId,
          staffAccountId,
          randomUUID(),
          guardianAccountId,
        ],
      );
      await admin.query(
        `INSERT INTO team_staff(id,org_id,team_season_id,person_id,role,status,added_by)
         VALUES ($1,$2,$3,$4,'head_coach','pending_compliance',$5)`,
        [staffId, orgId, teamSeasonId, personId, ownerId],
      );

      await expect(
        runActionCenterReminder(
          context(ownerId),
          'staff_compliance_reminders',
          withOrg,
          new Date('2026-09-28T12:00:00Z'),
        ),
      ).resolves.toEqual({ sentCount: 1, skippedCount: 0 });

      const notifications = await admin.query<{
        account_id: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT account_id,payload FROM notifications
         WHERE org_id=$1 AND type='staff.pending_compliance' AND payload->>'resourceId'=$2`,
        [orgId, staffId],
      );
      expect(notifications.rows).toHaveLength(1);
      expect(notifications.rows[0]?.account_id).toBe(staffAccountId);
      expect(notifications.rows[0]?.payload).toEqual({
        resourceType: 'team_staff',
        resourceId: staffId,
        personId,
        role: 'head_coach',
        href: `/portal/orgs/${orgId}/safety`,
      });
      expect(
        notifications.rows.some(
          ({ account_id }) => account_id === guardianAccountId,
        ),
      ).toBe(false);
    } finally {
      await admin.end();
    }
  });
});
