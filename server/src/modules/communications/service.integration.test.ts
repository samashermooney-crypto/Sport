import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import { createCommunicationNotificationSink } from './adapters';
import {
  CommunicationsAccessError,
  CommunicationsPermissionError,
  createCampaign,
  getCampaignDetail,
  listCampaigns,
} from './service';

let database: ReturnType<typeof createDatabase>;
let withOrg: ReturnType<typeof createWithOrg>;
const orgA = randomUUID();
const orgB = randomUUID();
const orgC = randomUUID();
const ownerA = randomUUID();
const ownerB = randomUUID();
const noRole = randomUUID();
const personId = randomUUID();
const contextA: OrgContext = { orgId: orgA, actor: { accountId: ownerA } };
const contextB: OrgContext = { orgId: orgB, actor: { accountId: ownerB } };
const noRoleContext: OrgContext = { orgId: orgC, actor: { accountId: noRole } };

beforeAll(async () => {
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    for (const [id, name] of [
      [ownerA, 'Campaign A'],
      [ownerB, 'Campaign B'],
      [noRole, 'Campaign C'],
    ] as const)
      await admin.query(
        'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
        [id, `${id}@example.invalid`, name, 'Owner', '1980-01-01'],
      );
    for (const [id, slug] of [
      [orgA, 'campaign-a'],
      [orgB, 'campaign-b'],
      [orgC, 'campaign-c'],
    ] as const)
      await admin.query(
        'INSERT INTO organizations(id,slug,name,kind,timezone) VALUES ($1,$2,$3,$4,$5)',
        [id, `${slug}-${id.slice(0, 6)}`, slug, 'club', 'UTC'],
      );
    for (const [orgId, accountId] of [
      [orgA, ownerA],
      [orgB, ownerB],
      [orgC, noRole],
    ] as const)
      await admin.query(
        'INSERT INTO org_memberships(id,org_id,account_id,status,joined_at) VALUES ($1,$2,$3,$4,now())',
        [randomUUID(), orgId, accountId, 'active'],
      );
    for (const [orgId, accountId] of [
      [orgA, ownerA],
      [orgB, ownerB],
    ] as const)
      await admin.query(
        'INSERT INTO role_assignments(id,org_id,account_id,role,scope_type,pending_mfa) VALUES ($1,$2,$3,$4,$5,false)',
        [randomUUID(), orgId, accountId, 'owner', 'org'],
      );
    await admin.query(
      'INSERT INTO people(id,org_id,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
      [personId, orgA, 'Alex', 'Athlete', '2012-01-01'],
    );
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  withOrg = createWithOrg(database);
});

afterAll(async () => database.destroy());

const draft = () => ({
  channels: ['email' as const],
  category: 'announcement' as const,
  audience: {
    include: { personIds: [personId] },
    exclude: {},
    filters: {},
  },
  subject: 'Season update',
  bodyHtml: '<p>Schedule update</p>',
  bodyText: 'Schedule update',
  smsText: '',
  pushText: '',
  localeVariants: {
    en: {
      subject: 'Season update',
      bodyHtml: '<p>Schedule update</p>',
      bodyText: 'Schedule update',
      smsText: '',
      pushText: '',
    },
    es: {
      subject: 'Actualización',
      bodyHtml: '<p>Horario</p>',
      bodyText: 'Horario',
      smsText: '',
      pushText: '',
    },
  },
});

describe('communications tenancy and permissions', () => {
  it('keeps campaigns inside their organization and requires an active communications role', async () => {
    const campaign = await createCampaign(
      contextA,
      draft(),
      'https://athlentry.test',
      withOrg,
    );
    await expect(
      getCampaignDetail(contextB, campaign.id, withOrg),
    ).rejects.toBeInstanceOf(CommunicationsAccessError);
    await expect(listCampaigns(contextB, withOrg)).resolves.toMatchObject({
      items: [],
    });
    await expect(
      createCampaign(noRoleContext, draft(), 'https://athlentry.test', withOrg),
    ).rejects.toBeInstanceOf(CommunicationsPermissionError);
  });

  it('uses the Track B notification service for in-app campaign and emergency delivery', async () => {
    const campaignId = randomUUID();
    const notificationDeliveryId = randomUUID();
    const notificationId = await createCommunicationNotificationSink(withOrg)({
      context: contextA,
      accountId: ownerA,
      type: 'communications.emergency',
      payload: { campaignId, deliveryId: notificationDeliveryId },
    });
    const notification = await withOrg(contextA, (trx) =>
      trx
        .selectFrom('notifications')
        .select(['id', 'type', 'payload'])
        .where('id', '=', notificationId)
        .executeTakeFirstOrThrow(),
    );

    expect(notification).toMatchObject({
      id: notificationId,
      type: 'safety.emergency',
      payload: {
        resourceType: 'message_campaign',
        resourceId: campaignId,
        href: `/me/orgs/${orgA}/messages`,
      },
    });
    const campaign = await createCampaign(
      contextA,
      {
        ...draft(),
        channels: ['in_app'],
        audience: {
          include: { roles: ['board'] },
          exclude: {},
          filters: {},
        },
      },
      'https://athlentry.test',
      withOrg,
    );
    const deliveryId = randomUUID();
    await withOrg(contextA, (trx) =>
      trx
        .insertInto('message_deliveries')
        .values({
          id: deliveryId,
          org_id: orgA,
          campaign_id: campaign.id,
          notification_id: notificationId,
          recipient_account_id: ownerA,
          person_id: null,
          channel: 'in_app',
          address: null,
          status: 'sent',
        })
        .execute()
        .then(() => undefined),
    );
    await expect(
      withOrg(contextA, (trx) =>
        trx
          .selectFrom('message_deliveries')
          .select(['campaign_id', 'notification_id'])
          .where('id', '=', deliveryId)
          .executeTakeFirstOrThrow(),
      ),
    ).resolves.toEqual({
      campaign_id: campaign.id,
      notification_id: notificationId,
    });
  });
});
