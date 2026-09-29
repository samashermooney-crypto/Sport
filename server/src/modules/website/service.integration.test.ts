import { randomUUID } from 'node:crypto';

import express from 'express';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app';
import { createDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import type { AuthDependencies } from '../auth/routes';

import { createSiteSsrRouter } from './public';
import {
  getWebsiteSettings,
  createPublicWebsiteContactSubmission,
  getPublicWebsiteContactPage,
  listWebsiteContactSubmissions,
  markWebsiteContactSubmissionsRead,
  getPublicWebsiteProgram,
  getPublicWebsitePrograms,
  getPublicWebsiteSchedule,
  getPublicWebsitePage,
  listWebsiteMenus,
  listWebsiteDomains,
  listWebsiteEmbeds,
  listPublicWebsiteNews,
  listWebsiteNews,
  listPublicWebsitePlans,
  listWebsitePages,
  saveWebsiteMenu,
  saveWebsitePage,
  saveWebsiteNews,
  saveWebsiteSettings,
  addWebsiteDomain,
  verifyWebsiteDomain,
  setPrimaryWebsiteDomain,
  disableWebsiteDomain,
  saveWebsiteEmbed,
} from './service';

const orgId = randomUUID();
const ownerId = randomUUID();
const orgSlug = `website-${orgId.slice(0, 8)}`;
let database: ReturnType<typeof createDatabase>;
let withOrg: ReturnType<typeof createWithOrg>;

const context: OrgContext = {
  orgId,
  actor: { accountId: ownerId },
};

beforeAll(async () => {
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    await admin.query(
      'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
      [ownerId, `${ownerId}@example.invalid`, 'Site', 'Owner', '1980-01-01'],
    );
    await admin.query(
      'INSERT INTO organizations(id,slug,name,kind,timezone,status) VALUES ($1,$2,$3,$4,$5,$6)',
      [orgId, orgSlug, 'Website Test Club', 'club', 'UTC', 'active'],
    );
    await admin.query(
      'INSERT INTO org_memberships(id,org_id,account_id,status) VALUES ($1,$2,$3,$4)',
      [randomUUID(), orgId, ownerId, 'active'],
    );
    await admin.query(
      'INSERT INTO role_assignments(id,org_id,account_id,role,scope_type,pending_mfa) VALUES ($1,$2,$3,$4,$5,false)',
      [randomUUID(), orgId, ownerId, 'owner', 'org'],
    );
    await admin.query(
      'INSERT INTO website_settings(org_id,published,theme) VALUES ($1,true,$2)',
      [orgId, JSON.stringify({ primary: '#3a67b2', secondary: '#252b2e' })],
    );
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  withOrg = createWithOrg(database);
});

afterAll(async () => database.destroy());

describe('website page service', () => {
  it('routes verified contact submissions to the protected organization inbox', async () => {
    const now = new Date('2026-09-28T18:00:00.000Z');
    const inboxEmail = `website-inbox-${orgId.slice(0, 8)}@example.invalid`;
    const coachId = randomUUID();
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    try {
      await admin.query(
        'UPDATE website_settings SET published = true, contact_inbox_email = $2 WHERE org_id = $1',
        [orgId, inboxEmail],
      );
      await admin.query(
        'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
        [
          coachId,
          `${coachId}@example.invalid`,
          'Public',
          'Coach',
          '1988-01-01',
        ],
      );
      await admin.query(
        'INSERT INTO org_memberships(id,org_id,account_id,status) VALUES ($1,$2,$3,$4)',
        [randomUUID(), orgId, coachId, 'active'],
      );
      const page = await getPublicWebsiteContactPage(
        database,
        orgSlug,
        withOrg,
      );
      expect(page?.navigation).toContainEqual({
        label: 'Contact',
        href: `/site/${orgSlug}/contact`,
      });

      const tokenDigest = 'a'.repeat(64);
      const created = await createPublicWebsiteContactSubmission(
        database,
        orgSlug,
        {
          name: 'Avery Guardian',
          email: 'avery@example.invalid',
          subject: 'Tryout dates',
          body: 'When will tryouts begin?',
          captchaToken: 'server-verified-token',
        },
        tokenDigest,
        '192.0.2.44',
        now,
        withOrg,
      );
      expect(created).toMatchObject({
        organizationName: 'Website Test Club',
        inboxEmail,
      });
      expect(created?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      const inbox = await listWebsiteContactSubmissions(context, withOrg);
      expect(inbox.items).toContainEqual({
        id: created?.id,
        name: 'Avery Guardian',
        email: 'avery@example.invalid',
        subject: 'Tryout dates',
        body: 'When will tryouts begin?',
        status: 'new',
        createdAt: now.toISOString(),
      });
      await expect(
        listWebsiteContactSubmissions(
          { orgId, actor: { accountId: coachId } },
          withOrg,
        ),
      ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
      await expect(
        markWebsiteContactSubmissionsRead(
          { orgId, actor: { accountId: coachId } },
          withOrg,
        ),
      ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect(await markWebsiteContactSubmissionsRead(context, withOrg)).toEqual(
        {
          updatedCount: 1,
        },
      );
      expect(await markWebsiteContactSubmissionsRead(context, withOrg)).toEqual(
        {
          updatedCount: 0,
        },
      );
      await expect(
        listWebsiteContactSubmissions(context, withOrg),
      ).resolves.toMatchObject({
        items: [expect.objectContaining({ id: created?.id, status: 'read' })],
      });

      const app = express();
      app.use(createSiteSsrRouter({ database }));
      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('The test server did not open a TCP port');
        const response = await fetch(
          `http://127.0.0.1:${String(address.port)}/${orgSlug}/contact`,
        );
        const html = await response.text();
        expect(response.status).toBe(200);
        expect(html).toContain(
          `action="/api/v1/website/public/${orgSlug}/contact"`,
        );
        expect(html).toContain('name="captchaToken"');
        expect(html).toContain('rel="preload"');
        expect(html).toContain('as="font"');
        expect(html).toContain(
          'memFYaGs126MiZpBA-UvWbX2vVnXBbObj2OVZyOOSr4dVJWUgsjZ0EwsQaPuWBIXazFHt1kuGajuKbEhWw',
        );
        expect(html).not.toContain(inboxEmail);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          }),
        );
      }
    } finally {
      await admin.query(
        'UPDATE website_settings SET contact_inbox_email = NULL WHERE org_id = $1',
        [orgId],
      );
      await admin.end();
    }
  });

  it('requires a matching DNS record and trusted TLS before a domain is primary', async () => {
    const added = await addWebsiteDomain(
      context,
      { host: `club-${orgId.slice(0, 8)}.example.test` },
      'athlentry.com',
      withOrg,
    );
    expect(added.domain).toMatchObject({
      status: 'pending',
      isPrimary: false,
    });
    expect(added.domain.verificationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(added.domain.verificationRecordName).toBe(
      `_athlentry-verification.${added.domain.host}`,
    );
    await expect(
      addWebsiteDomain(
        context,
        { host: added.domain.host },
        'athlentry.com',
        withOrg,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      addWebsiteDomain(
        context,
        { host: 'northstar.athlentry.com' },
        'athlentry.com',
        withOrg,
      ),
    ).rejects.toMatchObject({ status: 409 });

    const verify = (tlsReady: boolean) =>
      verifyWebsiteDomain(
        context,
        added.domain.id,
        new Date('2026-09-28T12:00:00.000Z'),
        withOrg,
        (recordName) => {
          expect(recordName).toBe(added.domain.verificationRecordName);
          return Promise.resolve([[added.domain.verificationToken ?? '']]);
        },
        () => Promise.resolve(tlsReady),
      );
    const ownershipVerified = await verify(false);
    expect(ownershipVerified.domain).toMatchObject({
      status: 'verifying',
      isPrimary: false,
      statusNote: 'Ownership verified; waiting for a trusted TLS certificate.',
    });
    await expect(
      setPrimaryWebsiteDomain(context, added.domain.id, withOrg),
    ).rejects.toMatchObject({ status: 409 });

    const active = await verify(true);
    expect(active.domain).toMatchObject({ status: 'active', isPrimary: false });
    expect(active.domain.verificationToken).toBeNull();
    expect(
      (await setPrimaryWebsiteDomain(context, added.domain.id, withOrg)).domain,
    ).toMatchObject({ status: 'active', isPrimary: true });
    const disabled = await disableWebsiteDomain(
      context,
      added.domain.id,
      withOrg,
    );
    expect(disabled.domain).toMatchObject({
      status: 'disabled',
      isPrimary: false,
    });
    expect((await listWebsiteDomains(context, withOrg)).items).toContainEqual(
      expect.objectContaining({ id: added.domain.id, status: 'disabled' }),
    );
  });

  it('saves typed public widgets with optimistic versions', async () => {
    const created = await saveWebsiteEmbed(
      context,
      undefined,
      {
        config: { kind: 'program_list', title: 'Upcoming programs', limit: 8 },
      },
      withOrg,
    );
    expect(created.embed.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.embed.config).toEqual({
      kind: 'program_list',
      title: 'Upcoming programs',
      limit: 8,
    });
    const updated = await saveWebsiteEmbed(
      context,
      created.embed.id,
      {
        expectedVersion: created.embed.version,
        config: { kind: 'registration_button', programSlug: 'summer-soccer' },
      },
      withOrg,
    );
    expect(updated.embed.version).toBe(created.embed.version + 1);
    expect(updated.embed.config.kind).toBe('registration_button');
    await expect(
      saveWebsiteEmbed(
        context,
        created.embed.id,
        {
          expectedVersion: created.embed.version,
          config: { kind: 'program_list' },
        },
        withOrg,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(listWebsiteEmbeds(context, withOrg)).resolves.toMatchObject({
      items: [
        {
          id: created.embed.id,
          version: updated.embed.version,
          config: { kind: 'registration_button', programSlug: 'summer-soccer' },
        },
      ],
    });
  });

  it('returns only public active plan fields for the pricing page', async () => {
    const inactiveId = randomUUID();
    const inactiveKey = `inactive-${inactiveId.slice(0, 8)}`;
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    await admin.query(
      'INSERT INTO plans(id,key,name,monthly_price_cents,application_fee_bps,application_fee_fixed_cents,limits,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [inactiveId, inactiveKey, 'Inactive test plan', 100, 0, 0, '{}', false],
    );
    try {
      const result = await listPublicWebsitePlans(database);
      expect(result.items).toContainEqual({
        key: 'pro',
        name: 'Pro',
        monthlyPriceCents: 9900,
        customPricing: false,
      });
      expect(result.items.some((plan) => plan.key === inactiveKey)).toBe(false);
      expect(Object.keys(result.items[0] ?? {}).sort()).toEqual([
        'customPricing',
        'key',
        'monthlyPriceCents',
        'name',
      ]);
    } finally {
      await admin.query('DELETE FROM plans WHERE id = $1', [inactiveId]);
      await admin.end();
    }
  });

  it('keeps drafts private and serves only a published page to the public', async () => {
    const created = await saveWebsitePage(
      context,
      undefined,
      {
        slug: 'about',
        title: 'About our club',
        blocks: [{ type: 'paragraph', text: 'A safe place to play.' }],
        seo: {
          title: 'About the club',
          description: 'Meet our community.',
          canonicalPath: '/site/website/about',
        },
        status: 'draft',
      },
      new Date('2026-09-27T12:00:00.000Z'),
      withOrg,
    );

    await expect(
      getPublicWebsitePage(database, orgSlug, 'about', withOrg),
    ).resolves.toBeNull();
    await expect(listWebsitePages(context, withOrg)).resolves.toMatchObject({
      items: [{ id: created.page.id, status: 'draft' }],
    });

    const published = await saveWebsitePage(
      context,
      created.page.id,
      {
        slug: 'about',
        title: 'About our club',
        blocks: [{ type: 'paragraph', text: 'A safe place to play.' }],
        seo: {
          title: 'About the club',
          description: 'Meet our community.',
          canonicalPath: '/site/website/about',
        },
        status: 'published',
        expectedVersion: created.page.version,
      },
      new Date('2026-09-27T12:01:00.000Z'),
      withOrg,
    );
    expect(published.page.version).toBe(created.page.version + 1);
    await saveWebsiteMenu(
      context,
      {
        location: 'header',
        items: [{ label: 'About', href: `/site/${orgSlug}/about` }],
        expectedVersion: 0,
      },
      withOrg,
    );
    await saveWebsiteMenu(
      context,
      {
        location: 'footer',
        items: [{ label: 'Contact', href: '/contact' }],
        expectedVersion: 0,
      },
      withOrg,
    );
    await expect(
      getPublicWebsitePage(database, orgSlug, 'about', withOrg),
    ).resolves.toMatchObject({
      organization: { name: 'Website Test Club' },
      page: { title: 'About our club', slug: 'about' },
      theme: { primary: '#3a67b2', secondary: '#252b2e' },
      navigation: [{ label: 'About', href: `/site/${orgSlug}/about` }],
      footerNavigation: [{ label: 'Contact', href: '/contact' }],
    });
  });

  it('publishes plain-text news posts with tenant and version checks', async () => {
    const draft = await saveWebsiteNews(
      context,
      undefined,
      {
        slug: 'season-opener',
        title: 'Season opener announced',
        excerpt: 'Registration starts next week.',
        bodyText: 'Join us <captains> at the community field.',
        status: 'draft',
      },
      new Date('2026-09-27T12:30:00.000Z'),
      withOrg,
    );
    await expect(listWebsiteNews(context, withOrg)).resolves.toMatchObject({
      items: [
        {
          id: draft.post.id,
          status: 'draft',
          bodyText: 'Join us <captains> at the community field.',
        },
      ],
    });
    await expect(
      listPublicWebsiteNews(database, orgSlug, withOrg),
    ).resolves.toMatchObject({ posts: [] });

    const published = await saveWebsiteNews(
      context,
      draft.post.id,
      {
        slug: 'season-opener',
        title: 'Season opener announced',
        excerpt: 'Registration starts next week.',
        bodyText: 'Join us <captains> at the community field.',
        status: 'published',
        expectedVersion: draft.post.version,
      },
      new Date('2026-09-27T12:31:00.000Z'),
      withOrg,
    );
    expect(published.post.version).toBe(draft.post.version + 1);
    const publicNews = await listPublicWebsiteNews(database, orgSlug, withOrg);
    expect(publicNews).toMatchObject({
      organization: { slug: orgSlug, name: 'Website Test Club' },
      theme: { primary: '#3a67b2', secondary: '#252b2e' },
      posts: [
        {
          slug: 'season-opener',
          title: 'Season opener announced',
          bodyText: 'Join us <captains> at the community field.',
          publishedAt: '2026-09-27T12:31:00.000Z',
        },
      ],
    });
    expect(publicNews?.navigation).toContainEqual({
      label: 'News',
      href: `/site/${orgSlug}/news`,
    });

    const app = express();
    app.use(createSiteSsrRouter({ database }));
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('The test server did not open a TCP port');
      const response = await fetch(
        `http://127.0.0.1:${String(address.port)}/${orgSlug}/news`,
      );
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain('<title>News · Website Test Club</title>');
      expect(html).toContain('<article>');
      expect(html).toContain(
        'Join us &lt;captains&gt; at the community field.',
      );
      expect(html).not.toContain('<captains>');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
    }
    await expect(
      saveWebsiteNews(
        context,
        draft.post.id,
        {
          slug: 'season-opener',
          title: 'Stale edit',
          excerpt: null,
          bodyText: 'Old content',
          status: 'published',
          expectedVersion: draft.post.version,
        },
        new Date(),
        withOrg,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('saves tenant website settings and menus with optimistic versions', async () => {
    await expect(getWebsiteSettings(context, withOrg)).resolves.toMatchObject({
      settings: {
        version: 1,
        published: true,
        robotsPolicy: 'index',
      },
    });
    const saved = await saveWebsiteSettings(
      context,
      {
        expectedVersion: 1,
        published: false,
        robotsPolicy: 'noindex',
        theme: { primary: '#174e82', secondary: '#29333c' },
        seo: {
          title: 'Northstar Sports',
          description: 'Programs for our community.',
          canonicalPath: '/about',
        },
        contactInboxEmail: 'website@example.invalid',
      },
      withOrg,
    );
    expect(saved.settings).toMatchObject({
      version: 2,
      published: false,
      robotsPolicy: 'noindex',
      theme: { primary: '#174e82', secondary: '#29333c' },
      contactInboxEmail: 'website@example.invalid',
    });
    await expect(
      saveWebsiteSettings(
        context,
        {
          expectedVersion: 1,
          published: true,
          robotsPolicy: 'index',
          theme: { primary: '#3a67b2', secondary: '#252b2e' },
          seo: { title: '', description: '', canonicalPath: '' },
          contactInboxEmail: null,
        },
        withOrg,
      ),
    ).rejects.toMatchObject({ status: 409 });

    await expect(listWebsiteMenus(context, withOrg)).resolves.toMatchObject({
      items: [
        {
          location: 'header',
          items: [{ label: 'About', href: `/site/${orgSlug}/about` }],
          version: 1,
        },
        {
          location: 'footer',
          items: [{ label: 'Contact', href: '/contact' }],
          version: 1,
        },
      ],
    });
    await expect(
      saveWebsiteMenu(
        context,
        {
          location: 'header',
          items: [{ label: 'Unsafe', href: 'javascript:alert(1)' }],
          expectedVersion: 1,
        },
        withOrg,
      ),
    ).rejects.toThrow();
  });

  it('rejects stale edits with an optimistic version conflict', async () => {
    const page = await saveWebsitePage(
      context,
      undefined,
      {
        slug: 'history',
        title: 'Our history',
        blocks: [],
        seo: { title: '', description: '', canonicalPath: '' },
      },
      new Date(),
      withOrg,
    );
    await saveWebsitePage(
      context,
      page.page.id,
      {
        slug: 'history',
        title: 'Our club history',
        blocks: [],
        seo: { title: '', description: '', canonicalPath: '' },
        expectedVersion: 1,
      },
      new Date(),
      withOrg,
    );
    await expect(
      saveWebsitePage(
        context,
        page.page.id,
        {
          slug: 'history',
          title: 'Our history',
          blocks: [],
          seo: { title: '', description: '', canonicalPath: '' },
          expectedVersion: 1,
        },
        new Date(),
        withOrg,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('renders public program and schedule pages without leaking private activity', async () => {
    const seasonId = randomUUID();
    const sportProfileId = randomUUID();
    const publicProgramId = randomUUID();
    const privateProgramId = randomUUID();
    const publicOfferingId = randomUUID();
    const publicEventId = randomUUID();
    const privateEventId = randomUUID();
    const publicProgramSlug = `open-soccer-${publicProgramId.slice(0, 8)}`;
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    try {
      await admin.query(
        "UPDATE website_settings SET published = true, robots_policy = 'index' WHERE org_id = $1",
        [orgId],
      );
      await admin.query(
        `INSERT INTO sport_profiles (id, org_id, name, profile)
         VALUES ($1, $2, 'Soccer', '{}'::jsonb)`,
        [sportProfileId, orgId],
      );
      await admin.query(
        `INSERT INTO seasons (id, org_id, name, starts_on, ends_on, status)
         VALUES ($1, $2, 'Fall 2026', '2026-09-01', '2026-12-31', 'active')`,
        [seasonId, orgId],
      );
      await admin.query(
        `INSERT INTO programs (id, org_id, season_id, sport_profile_id, mode, name, slug, status, visibility, starts_on, ends_on)
         VALUES ($1, $2, $3, $4, 'league', 'Open Soccer', $5, 'registration_open', 'public', '2026-10-01', '2026-11-01'),
                ($6, $2, $3, $4, 'club', 'Private Coaching', $7, 'published', 'private', '2026-10-01', '2026-11-01')`,
        [
          publicProgramId,
          orgId,
          seasonId,
          sportProfileId,
          publicProgramSlug,
          privateProgramId,
          `private-coaching-${privateProgramId.slice(0, 8)}`,
        ],
      );
      await admin.query(
        `INSERT INTO registration_offerings (id, org_id, program_id, name, registrant_role, visibility, active)
         VALUES ($1, $2, $3, 'Player registration', 'athlete', 'public', true)`,
        [publicOfferingId, orgId, publicProgramId],
      );
      await admin.query(
        `INSERT INTO events (id, org_id, program_id, kind, title, starts_at, ends_at, timezone, location_text, published)
         VALUES ($1, $2, $3, 'game', 'Open Soccer season opener', '2026-10-14T15:00:00Z', '2026-10-14T16:00:00Z', 'America/Chicago', 'North Park Field 1', true),
                ($4, $2, $5, 'meeting', 'Private coaching assessment', '2026-10-15T15:00:00Z', '2026-10-15T16:00:00Z', 'America/Chicago', 'Staff room', true)`,
        [
          publicEventId,
          orgId,
          publicProgramId,
          privateEventId,
          privateProgramId,
        ],
      );

      const programs = await getPublicWebsitePrograms(
        database,
        orgSlug,
        withOrg,
      );
      expect(programs?.programs).toEqual([
        expect.objectContaining({
          slug: publicProgramSlug,
          name: 'Open Soccer',
          seasonName: 'Fall 2026',
        }),
      ]);
      await expect(
        getPublicWebsiteProgram(database, orgSlug, publicProgramSlug, withOrg),
      ).resolves.toMatchObject({
        program: { registrationAvailable: true, name: 'Open Soccer' },
      });
      await expect(
        getPublicWebsiteProgram(
          database,
          orgSlug,
          `private-coaching-${privateProgramId.slice(0, 8)}`,
          withOrg,
        ),
      ).resolves.toBeNull();
      const schedule = await getPublicWebsiteSchedule(
        database,
        orgSlug,
        withOrg,
        new Date('2026-09-28T00:00:00.000Z'),
      );
      expect(schedule?.events).toEqual([
        expect.objectContaining({
          id: publicEventId,
          title: 'Open Soccer season opener',
          programName: 'Open Soccer',
        }),
      ]);

      const app = express();
      app.use(createSiteSsrRouter({ database }));
      const server = app.listen(0);
      await new Promise<void>((resolve) => server.once('listening', resolve));
      try {
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('The test server did not open a TCP port');
        const origin = `http://127.0.0.1:${String(address.port)}`;
        const programsResponse = await fetch(`${origin}/${orgSlug}/programs`);
        const programsHtml = await programsResponse.text();
        expect(programsResponse.status).toBe(200);
        expect(programsHtml).toContain(
          '<title>Programs · Website Test Club</title>',
        );
        expect(programsHtml).toContain('Open Soccer');
        expect(programsHtml).not.toContain('Private Coaching');
        expect(programsHtml).not.toContain('private-coaching-');
        expect(programsHtml).toContain('/schedule');

        const detailResponse = await fetch(
          `${origin}/${orgSlug}/programs/${publicProgramSlug}`,
        );
        const detailHtml = await detailResponse.text();
        expect(detailResponse.status).toBe(200);
        expect(detailHtml).toContain('View registration options');

        const scheduleResponse = await fetch(`${origin}/${orgSlug}/schedule`);
        const scheduleHtml = await scheduleResponse.text();
        expect(scheduleResponse.status).toBe(200);
        expect(scheduleHtml).toContain('SportsEvent');
        expect(scheduleHtml).toContain('Open Soccer season opener');
        expect(scheduleHtml).toContain('North Park Field 1');
        expect(scheduleHtml).not.toContain('Private coaching assessment');
        expect(scheduleHtml).not.toContain('Staff room');
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          }),
        );
      }
    } finally {
      await admin.query('DELETE FROM events WHERE id IN ($1, $2)', [
        publicEventId,
        privateEventId,
      ]);
      await admin.query('DELETE FROM registration_offerings WHERE id = $1', [
        publicOfferingId,
      ]);
      await admin.query('DELETE FROM divisions WHERE program_id IN ($1, $2)', [
        publicProgramId,
        privateProgramId,
      ]);
      await admin.query('DELETE FROM programs WHERE id IN ($1, $2)', [
        publicProgramId,
        privateProgramId,
      ]);
      await admin.query('DELETE FROM seasons WHERE id = $1', [seasonId]);
      // Sport profile snapshots are append-only; the isolated test database is dropped after this file.
      await admin.end();
    }
  });

  it('mounts site SSR and host-root SEO routes only for routable hosts', async () => {
    const customHost = `club-${orgId.slice(0, 8)}.example.test`;
    const pendingHost = `pending-${orgId.slice(0, 8)}.example.test`;
    const admin = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await admin.connect();
    await admin.query(
      `INSERT INTO site_domains
       (id, org_id, host, kind, status, verify_token, verification_method, verified_at, is_primary)
       VALUES ($1, $2, $3, 'custom', 'active', 'test-token', 'txt', now(), true),
              ($4, $2, $5, 'custom', 'pending', 'pending-token', 'txt', NULL, false)`,
      [randomUUID(), orgId, customHost, randomUUID(), pendingHost],
    );
    await admin.end();

    await saveWebsitePage(
      context,
      undefined,
      {
        slug: 'home',
        title: 'Custom Domain Home',
        blocks: [
          { type: 'paragraph', text: 'Published on the verified host.' },
        ],
        seo: { title: '', description: '', canonicalPath: '' },
        status: 'published',
      },
      new Date('2026-09-29T12:00:00.000Z'),
      withOrg,
    );

    const unscopedDomainRows = await database
      .selectFrom('site_domains')
      .select('id')
      .where('host', '=', customHost)
      .execute();
    expect(unscopedDomainRows).toEqual([]);

    const app = createApp({
      database,
      captchaWidget: { mode: 'preview' },
    } as unknown as AuthDependencies);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('The test server did not open a TCP port');
      const origin = `http://127.0.0.1:${String(address.port)}`;
      const hostHeaders = { Host: customHost, Accept: 'text/html' };
      const home = await fetch(origin, { headers: hostHeaders });
      const homeHtml = await home.text();
      expect(home.status).toBe(200);
      expect(homeHtml).toContain(
        '<title>Custom Domain Home · Website Test Club</title>',
      );
      expect(homeHtml).toContain('Published on the verified host.');

      const mountedSite = await fetch(`${origin}/site/${orgSlug}`, {
        headers: hostHeaders,
      });
      expect(mountedSite.status).toBe(200);
      expect(await mountedSite.text()).toContain('Custom Domain Home');

      const robots = await fetch(`${origin}/robots.txt`, {
        headers: { Host: customHost },
      });
      expect(robots.status).toBe(200);
      expect(await robots.text()).toContain(
        `Sitemap: https://${customHost}/sitemap.xml`,
      );

      const sitemap = await fetch(`${origin}/sitemap.xml`, {
        headers: { Host: customHost },
      });
      const sitemapXml = await sitemap.text();
      expect(sitemap.status).toBe(200);
      expect(sitemapXml).toContain(`https://${customHost}/`);
      expect(sitemapXml).toContain(`https://${customHost}/programs`);
      expect(sitemapXml).not.toContain('.athlentry.com');

      const unverified = await fetch(`${origin}/site/${orgSlug}`, {
        headers: { Host: pendingHost, Accept: 'text/html' },
      });
      expect(unverified.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        }),
      );
      const cleanup = new pg.Client({
        connectionString: process.env.TEST_DATABASE_URL,
      });
      await cleanup.connect();
      try {
        await cleanup.query('DELETE FROM site_domains WHERE host IN ($1, $2)', [
          customHost,
          pendingHost,
        ]);
      } finally {
        await cleanup.end();
      }
    }
  });

  it('reserves generated website paths for the public renderer', async () => {
    await expect(
      saveWebsitePage(
        context,
        undefined,
        {
          slug: 'programs',
          title: 'My custom programs page',
          blocks: [],
          seo: { title: '', description: '', canonicalPath: '' },
        },
        new Date(),
        withOrg,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});
