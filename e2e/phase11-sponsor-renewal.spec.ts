import { expect, test } from '@playwright/test';

import { createDatabase } from '../server/src/db/kysely';
import { createWithOrg } from '../server/src/db/withOrg';
import {
  createSponsor,
  getSponsor,
  runSponsorRenewalJob,
  setSponsorStatus,
} from '../server/src/modules/sponsors/service';
import { createTestFactories } from '../server/test/factories';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test.fixme('QA-ACC-045 / Tracks H and B: an upcoming sponsor contract notifies its finance owner', async () => {
  const database = createDatabase(
    `postgres://athlentry_app@127.0.0.1:${String(5432 + offset)}/athlentry_e2e`,
  );
  try {
    const owner = await createTestFactories(database).actor();
    const now = new Date('2026-09-27T18:00:00.000Z');
    const start = '2026-09-01';
    const end = '2026-10-15';
    await createWithOrg(database)(owner, async (trx) => {
      await trx
        .updateTable('organizations')
        .set({ status: 'active' })
        .where('id', '=', owner.orgId)
        .execute();
      await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', owner.orgId)
        .where('account_id', '=', owner.accountId)
        .execute();
    });
    const sponsorId = await createSponsor(database, owner, {
      name: `QA renewal ${owner.orgId}`,
      contact: { accountId: owner.accountId },
      tier: 'Gold',
      amountCents: 25_000,
      contractStart: start,
      contractEnd: end,
      placements: [],
      status: 'prospect',
    });
    const sponsor = await getSponsor(database, owner, sponsorId);
    await setSponsorStatus(database, owner, sponsorId, {
      status: 'active',
      expectedVersion: sponsor.version,
    });

    await runSponsorRenewalJob(database, now);
    await runSponsorRenewalJob(
      database,
      new Date(now.getTime() + 24 * 60 * 60 * 1_000),
    );

    const notifications = await createWithOrg(database)(owner, (trx) =>
      trx
        .selectFrom('notifications')
        .select(['type', 'payload'])
        .where('org_id', '=', owner.orgId)
        .where('account_id', '=', owner.accountId)
        .where('type', '=', 'sponsor.renewal_reminder')
        .execute(),
    );
    const reminders = notifications.filter((notification) => {
      const payload = notification.payload;
      return (
        payload !== null &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        payload.resourceId === sponsorId
      );
    });
    expect(reminders).toHaveLength(1);
  } finally {
    await database.destroy();
  }
});
