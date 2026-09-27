import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';

import {
  createNotification,
  listInbox,
  listPreferences,
  markNotificationRead,
  NotificationAccessError,
  updatePreference,
} from './service';
import { notificationChannel, notificationStreamEvent } from './stream';

const orgId = randomUUID();
const otherOrgId = randomUUID();
const accountId = randomUUID();
const otherAccountId = randomUUID();
const context = { orgId, actor: { accountId } };
let database: ReturnType<typeof createDatabase>;

beforeAll(async () => {
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    for (const id of [accountId, otherAccountId])
      await admin.query(
        'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
        [id, `${id}@example.invalid`, 'Notification', 'Tester', '1990-01-01'],
      );
    for (const id of [orgId, otherOrgId])
      await admin.query(
        'INSERT INTO organizations(id,slug,name,kind,timezone) VALUES ($1,$2,$3,$4,$5)',
        [id, `notify-${id.slice(0, 8)}`, 'Notifications', 'club', 'UTC'],
      );
    await admin.query(
      'INSERT INTO org_memberships(id,org_id,account_id,status) VALUES ($1,$2,$3,$4)',
      [randomUUID(), orgId, accountId, 'active'],
    );
    await admin.query(
      'INSERT INTO org_memberships(id,org_id,account_id,status) VALUES ($1,$2,$3,$4)',
      [randomUUID(), orgId, otherAccountId, 'active'],
    );
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => database.destroy());

describe('notification inbox and preferences', () => {
  it('commits an in-app notification, emits an account-filtered event and audits read state', async () => {
    const listener = new pg.Client({
      connectionString: process.env.TEST_DATABASE_APP_URL,
    });
    await listener.connect();
    await listener.query(`LISTEN ${notificationChannel}`);
    const notification = new Promise<string>((resolve) => {
      listener.once('notification', (message: pg.Notification) => {
        resolve(message.payload ?? '');
      });
    });
    const runWithOrg = createWithOrg(database);
    const id = await runWithOrg(context, (trx) =>
      createNotification(trx, context, {
        accountId,
        type: 'registration.confirmed',
        payload: { resourceType: 'registration', resourceId: randomUUID() },
      }),
    );
    const event = notificationStreamEvent(await notification, accountId);
    expect(event).toMatchObject({ id, event: 'notification' });
    expect(
      notificationStreamEvent(
        JSON.stringify({ id, orgId, accountId }),
        otherAccountId,
      ),
    ).toBeNull();
    await listener.end();
    const page = await listInbox(context, { limit: 50 }, runWithOrg);
    expect(page.items).toMatchObject([
      { id, type: 'registration.confirmed', title: 'Registration confirmed' },
    ]);
    expect(
      await listInbox(
        { orgId, actor: { accountId: otherAccountId } },
        { limit: 50 },
        runWithOrg,
      ),
    ).toMatchObject({ items: [] });
    const readAt = await markNotificationRead(
      context,
      id,
      new Date(),
      runWithOrg,
    );
    expect(readAt).toBeInstanceOf(Date);
    expect(
      (await listInbox(context, { limit: 50, unreadOnly: true }, runWithOrg))
        .items,
    ).toEqual([]);
    const audits = await runWithOrg(context, (trx) =>
      trx
        .selectFrom('audit_log')
        .select('action')
        .where('org_id', '=', orgId)
        .execute(),
    );
    expect(audits.map((row) => row.action)).toContain('notification.read');
  });

  it('keeps at least one operational channel and applies version checks', async () => {
    const runWithOrg = createWithOrg(database);
    const defaults = await listPreferences(context, runWithOrg);
    expect(defaults.items).toHaveLength(8);
    expect(
      defaults.items.every(
        (item) =>
          item.version === 0 &&
          item.enabled === (item.category !== 'marketing'),
      ),
    ).toBe(true);
    const email = await updatePreference(
      context,
      {
        category: 'operational',
        channel: 'email',
        enabled: false,
        expectedVersion: 0,
      },
      runWithOrg,
    );
    expect(email).toMatchObject({ enabled: false, version: 1 });
    await expect(
      updatePreference(
        context,
        {
          category: 'operational',
          channel: 'in_app',
          enabled: false,
          expectedVersion: 0,
        },
        runWithOrg,
      ),
    ).rejects.toThrow('At least one delivery channel');
    await expect(
      updatePreference(
        context,
        {
          category: 'operational',
          channel: 'email',
          enabled: true,
          expectedVersion: 0,
        },
        runWithOrg,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await updatePreference(
      context,
      {
        category: 'operational',
        channel: 'email',
        enabled: true,
        expectedVersion: 1,
      },
      runWithOrg,
    );
    const concurrent = await Promise.allSettled([
      updatePreference(
        context,
        {
          category: 'operational',
          channel: 'email',
          enabled: false,
          expectedVersion: 2,
        },
        runWithOrg,
      ),
      updatePreference(
        context,
        {
          category: 'operational',
          channel: 'in_app',
          enabled: false,
          expectedVersion: 0,
        },
        runWithOrg,
      ),
    ]);
    expect(concurrent.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const current = await listPreferences(context, runWithOrg);
    expect(
      current.items
        .filter((item) => item.category === 'operational')
        .some((item) => item.enabled),
    ).toBe(true);
  });

  it('hides another tenant and another account notification IDs', async () => {
    const runWithOrg = createWithOrg(database);
    await expect(
      listInbox(
        { orgId: otherOrgId, actor: { accountId } },
        { limit: 50 },
        runWithOrg,
      ),
    ).rejects.toBeInstanceOf(NotificationAccessError);
    await expect(
      markNotificationRead(
        { orgId, actor: { accountId: otherAccountId } },
        randomUUID(),
        new Date(),
        runWithOrg,
      ),
    ).rejects.toBeInstanceOf(NotificationAccessError);
  });
});
