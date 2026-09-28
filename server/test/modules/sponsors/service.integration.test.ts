import { randomUUID } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';
import { orgToday } from '@shared/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../../src/db/kysely';
import { createWithOrg } from '../../../src/db/withOrg';
import {
  createSponsor,
  getSponsor,
  issueSponsorInvoice,
  publicSponsorPlacements,
  setSponsorStatus,
  SponsorNotFoundError,
} from '../../../src/modules/sponsors/service';
import { createTestFactories } from '../../factories';

let database: ReturnType<typeof createDatabase>;

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => database.destroy());

describe('sponsor contracts and public placements', () => {
  it('keeps placements tenant scoped and issues sponsorship invoices through finance', async () => {
    const factories = createTestFactories(database);
    const owner = await factories.actor();
    const otherOwner = await factories.actor();
    await createWithOrg(database)(owner, async (trx) =>
      trx
        .updateTable('organizations')
        .set({ status: 'active' })
        .where('id', '=', owner.orgId)
        .execute(),
    );
    const now = new Date();
    const organization = await createWithOrg(database)(owner, (trx) =>
      trx
        .selectFrom('organizations')
        .select('timezone')
        .where('id', '=', owner.orgId)
        .executeTakeFirstOrThrow(),
    );
    const start = orgToday(
      organization.timezone,
      Temporal.Instant.fromEpochMilliseconds(now.getTime()),
    );
    const end = Temporal.PlainDate.from(start).add({ days: 20 }).toString();
    const sponsorId = await createSponsor(database, owner, {
      name: 'Community Sports Medicine',
      contact: {
        name: 'Jamie Partner',
        email: 'partner@example.test',
        accountId: owner.accountId,
      },
      websiteUrl: 'https://partner.example.test',
      tier: 'Gold',
      amountCents: 250_000,
      contractStart: start,
      contractEnd: end,
      placements: [{ surface: 'website_home' }],
      status: 'prospect',
    });
    const prospect = await getSponsor(database, owner, sponsorId);
    expect(prospect).toMatchObject({
      name: 'Community Sports Medicine',
      status: 'prospect',
      amountCents: 250_000,
    });
    const active = await setSponsorStatus(database, owner, sponsorId, {
      status: 'active',
      expectedVersion: prospect.version,
    });

    const slug = await createWithOrg(database)(owner, async (trx) =>
      trx
        .selectFrom('organizations')
        .select('slug')
        .where('id', '=', owner.orgId)
        .executeTakeFirstOrThrow(),
    );
    const placements = await publicSponsorPlacements(
      database,
      slug.slug,
      'website_home',
      undefined,
      now,
    );
    expect(placements).toEqual([
      expect.objectContaining({
        id: sponsorId,
        name: 'Community Sports Medicine',
        tier: 'Gold',
      }),
    ]);
    await expect(
      getSponsor(database, otherOwner, sponsorId),
    ).rejects.toBeInstanceOf(SponsorNotFoundError);

    const invoice = await issueSponsorInvoice(database, owner, sponsorId, {
      amountCents: 250_000,
      dueOn: end,
      creationKey: randomUUID(),
    });
    expect(invoice).toMatchObject({ totalCents: 250_000 });
    expect(await getSponsor(database, owner, sponsorId)).toMatchObject({
      invoiceId: invoice.invoiceId,
      invoiceStatus: 'open',
      status: 'active',
      version: active.version + 1,
    });
  });
});
