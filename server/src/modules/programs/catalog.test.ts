import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { newId } from '@shared/ids';
import { builtInSportTemplatesByKey } from '@shared/sport/templates';
import express from 'express';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB, Json } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import type { AuthDependencies } from '../auth/routes';
import { OfferingsService } from '../offerings/service';
import { SeasonsService } from '../seasons/service';

import { createProgramsRouter } from './routes';
import { ProgramsService } from './service';

const origin = 'http://127.0.0.1:5173';
let database: Kysely<DB>;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let orgSlug: string;
let suspendedSlug: string;
let publicSlug: string;
let privateSlug: string;

const seedOrg = async (slug: string, status: string) => {
  const accountId = newId();
  const orgId = newId();
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: `catalog-${randomUUID()}@example.invalid`,
      first_name: 'Catalog',
      last_name: 'Owner',
      date_of_birth: '1980-01-01',
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug,
      name: `Catalog ${slug}`,
      kind: 'club',
      timezone: 'UTC',
      status,
    })
    .execute();
  const context: OrgContext = { orgId, actor: { accountId } };
  await createWithOrg(database)(context, async (trx) => {
    await trx
      .insertInto('org_memberships')
      .values({
        id: newId(),
        org_id: orgId,
        account_id: accountId,
        status: 'active',
        joined_at: new Date(),
      })
      .execute();
    await trx
      .insertInto('role_assignments')
      .values({
        id: newId(),
        org_id: orgId,
        account_id: accountId,
        role: 'owner',
        scope_type: 'org',
        pending_mfa: false,
      })
      .execute();
  });
  return context;
};

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  orgSlug = `catalog-${randomUUID().slice(0, 12)}`;
  suspendedSlug = `suspended-${randomUUID().slice(0, 12)}`;
  publicSlug = `public-${randomUUID().slice(0, 8)}`;
  privateSlug = `private-${randomUUID().slice(0, 8)}`;
  const context = await seedOrg(orgSlug, 'active');
  await seedOrg(suspendedSlug, 'suspended');
  const seasons = new SeasonsService(database, context);
  const programs = new ProgramsService(database, context);
  const offerings = new OfferingsService(database, context);
  const profile = builtInSportTemplatesByKey.get('volleyball');
  if (!profile) throw new Error('Volleyball template unavailable');
  const season = await seasons.create({
    name: 'Catalog Season',
    startsOn: '2027-01-01',
    endsOn: '2027-06-30',
  });
  const profileId = await createWithOrg(database)(context, async (trx) => {
    const row = await trx
      .insertInto('sport_profiles')
      .values({
        id: newId(),
        org_id: context.orgId,
        template_key: null,
        name: profile.name.en,
        profile: profile as Json,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });
  const published = await programs.create({
    seasonId: season.id,
    sportProfileId: profileId,
    mode: 'league',
    name: 'Open League',
    slug: publicSlug,
    startsOn: '2027-02-01',
    endsOn: '2027-05-01',
    visibility: 'public',
  });
  await programs.setStatus(published.id, 'published', published.version);
  await programs.create({
    seasonId: season.id,
    sportProfileId: profileId,
    mode: 'league',
    name: 'Draft League',
    slug: `draft-${randomUUID().slice(0, 8)}`,
    startsOn: '2027-02-01',
    endsOn: '2027-05-01',
    visibility: 'public',
  });
  const hidden = await programs.create({
    seasonId: season.id,
    sportProfileId: profileId,
    mode: 'league',
    name: 'Private League',
    slug: privateSlug,
    startsOn: '2027-02-01',
    endsOn: '2027-05-01',
    visibility: 'private',
  });
  await programs.setStatus(hidden.id, 'published', hidden.version);
  await offerings.create({
    programId: published.id,
    name: 'Public Player',
    registrantRole: 'athlete',
    priceCents: 9000,
    visibility: 'public',
    active: true,
  });
  await offerings.create({
    programId: published.id,
    name: 'Inactive Player',
    registrantRole: 'athlete',
    priceCents: 9000,
    visibility: 'public',
    active: false,
  });
  await offerings.create({
    programId: published.id,
    name: 'Staff Only Player',
    registrantRole: 'athlete',
    priceCents: 9000,
    visibility: 'staff_only',
    active: true,
  });
  const app = express();
  app.use(
    '/api/v1/programs',
    createProgramsRouter({
      database,
      appUrl: origin,
    } as AuthDependencies),
  );
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${String(
    (server.address() as AddressInfo).port,
  )}/api/v1/programs`;
});

afterAll(async () => {
  server.close();
  await database.destroy();
});

describe('public program catalog', () => {
  it('lists only public programs in public statuses with public offerings', async () => {
    const response = await fetch(`${baseUrl}/catalog/${orgSlug}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      organization: { slug: string; name: string };
      programs: Array<{
        slug: string;
        divisions: unknown[];
        offerings: Array<{ name: string }>;
      }>;
    };
    expect(body.organization.slug).toBe(orgSlug);
    expect(body.programs).toHaveLength(1);
    const program = body.programs.at(0);
    if (!program) throw new Error('Catalog program missing');
    expect(program.slug).toBe(publicSlug);
    expect(program.divisions).toEqual([]);
    expect(program.offerings.map((o) => o.name)).toEqual(['Public Player']);
    expect(JSON.stringify(program)).not.toContain('Staff Only');
  });

  it('returns a single program and hides non-public siblings', async () => {
    const found = await fetch(`${baseUrl}/catalog/${orgSlug}/${publicSlug}`);
    expect(found.status).toBe(200);
    const detail = (await found.json()) as { programs: unknown[] };
    expect(detail.programs).toHaveLength(1);
    expect(
      (await fetch(`${baseUrl}/catalog/${orgSlug}/${privateSlug}`)).status,
    ).toBe(404);
    expect(
      (await fetch(`${baseUrl}/catalog/${orgSlug}/no-such-program`)).status,
    ).toBe(404);
  });

  it('hides catalogs for suspended or unknown organizations', async () => {
    expect((await fetch(`${baseUrl}/catalog/${suspendedSlug}`)).status).toBe(
      404,
    );
    expect((await fetch(`${baseUrl}/catalog/no-such-org`)).status).toBe(404);
  });
});
