import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';

import {
  getWebsiteSettings,
  getPublicWebsitePage,
  listWebsiteMenus,
  listPublicWebsitePlans,
  listWebsitePages,
  saveWebsiteMenu,
  saveWebsitePage,
  saveWebsiteSettings,
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
});
