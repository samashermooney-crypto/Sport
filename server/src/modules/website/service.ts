import { randomUUID } from 'node:crypto';

import {
  websiteMenuBodySchema,
  websiteMenuListSchema,
  websiteMenuSchema,
  websiteMenuItemSchema,
  websitePageBodySchema,
  websitePageListSchema,
  websitePageSchema,
  websitePublicPageSchema,
  websiteSettingsBodySchema,
  websiteSettingsSchema,
} from '@shared/schemas/website';
import type { Kysely } from 'kysely';

import type { DB, Json } from '../../db/types';
import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { appendAuditEvent } from '../audit/service';

import { WebsiteError, requireWebsiteEditor } from './policy';

const publicActor = '00000000-0000-0000-0000-000000000000';
type WebsiteDatabase = Kysely<DB>;

export async function listPublicWebsitePlans(database: WebsiteDatabase) {
  const rows = await database
    .selectFrom('plans')
    .select(['key', 'name', 'monthly_price_cents', 'limits'])
    .where('active', '=', true)
    .orderBy('monthly_price_cents')
    .orderBy('name')
    .execute();
  return {
    items: rows.map((row) => {
      const limits =
        typeof row.limits === 'object' &&
        row.limits !== null &&
        !Array.isArray(row.limits)
          ? row.limits
          : {};
      const customPricing =
        'customPricing' in limits && limits.customPricing === true;
      const priceValue: unknown = row.monthly_price_cents;
      const monthlyPriceCents =
        typeof priceValue === 'number'
          ? priceValue
          : typeof priceValue === 'string'
            ? Number(priceValue)
            : Number.NaN;
      if (!Number.isSafeInteger(monthlyPriceCents) || monthlyPriceCents < 0)
        throw new RangeError('Plan pricing is invalid');
      return {
        key: row.key,
        name: row.name,
        monthlyPriceCents,
        customPricing,
      };
    }),
  };
}

function pageSummary(row: {
  id: string;
  slug: string;
  title: string;
  blocks: Json;
  seo: Json;
  status: string;
  version: number;
  updated_at: Date;
}) {
  return websitePageSchema.parse({
    id: row.id,
    slug: row.slug,
    title: row.title,
    blocks: row.blocks,
    seo: row.seo,
    status: row.status,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  });
}

async function authorizeEditor(
  trx: OrgTransaction,
  context: OrgContext,
): Promise<void> {
  await requireWebsiteEditor(trx, context.orgId, context.actor.accountId);
}

export async function listWebsitePages(
  context: OrgContext,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await authorizeEditor(trx, context);
    const rows = await trx
      .selectFrom('website_pages')
      .select([
        'id',
        'slug',
        'title',
        'blocks',
        'seo',
        'status',
        'version',
        'updated_at',
      ])
      .orderBy('updated_at', 'desc')
      .execute();
    return websitePageListSchema.parse({ items: rows.map(pageSummary) });
  });
}

function settingsSummary(row?: {
  version: number;
  published: boolean;
  robots_policy: string;
  theme: Json;
  seo: Json;
  contact_inbox_email: string | null;
}) {
  return websiteSettingsSchema.parse({
    version: row?.version ?? 0,
    published: row?.published ?? false,
    robotsPolicy: row?.robots_policy ?? 'index',
    theme: readTheme(row?.theme ?? {}),
    seo: row?.seo ?? {},
    contactInboxEmail: row?.contact_inbox_email ?? null,
  });
}

export async function getWebsiteSettings(
  context: OrgContext,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await authorizeEditor(trx, context);
    const row = await trx
      .selectFrom('website_settings')
      .select([
        'version',
        'published',
        'robots_policy',
        'theme',
        'seo',
        'contact_inbox_email',
      ])
      .executeTakeFirst();
    return { settings: settingsSummary(row) };
  });
}

export async function saveWebsiteSettings(
  context: OrgContext,
  bodyInput: unknown,
  runWithOrg: typeof withOrg = withOrg,
) {
  const body = websiteSettingsBodySchema.parse(bodyInput);
  return runWithOrg(context, async (trx) => {
    await authorizeEditor(trx, context);
    const current = await trx
      .selectFrom('website_settings')
      .select('version')
      .where('org_id', '=', context.orgId)
      .executeTakeFirst();
    const version = current?.version ?? 0;
    if (version !== body.expectedVersion)
      throw new WebsiteError(
        409,
        'CONFLICT',
        'Website settings changed in another session. Reload and try again.',
      );
    const values = {
      theme: JSON.stringify(body.theme) as unknown as Json,
      seo: JSON.stringify(body.seo) as unknown as Json,
      contact_inbox_email: body.contactInboxEmail,
      robots_policy: body.robotsPolicy,
      published: body.published,
      version: version + 1,
    };
    const returning = [
      'version',
      'published',
      'robots_policy',
      'theme',
      'seo',
      'contact_inbox_email',
    ] as const;
    const saved = current
      ? await trx
          .updateTable('website_settings')
          .set(values)
          .where('org_id', '=', context.orgId)
          .where('version', '=', version)
          .returning(returning)
          .executeTakeFirst()
      : await trx
          .insertInto('website_settings')
          .values({ org_id: context.orgId, ...values })
          .onConflict((conflict) => conflict.column('org_id').doNothing())
          .returning(returning)
          .executeTakeFirst();
    if (!saved)
      throw new WebsiteError(409, 'CONFLICT', 'Website settings conflicted');
    await appendAuditEvent(trx, context, {
      action: 'website.settings.updated',
      entityType: 'website_settings',
      entityId: context.orgId,
      changes: {
        published: { tier: 'internal', after: body.published },
        robotsPolicy: { tier: 'internal', after: body.robotsPolicy },
      },
    });
    return { settings: settingsSummary(saved) };
  });
}

export async function listWebsiteMenus(
  context: OrgContext,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await authorizeEditor(trx, context);
    const rows = await trx
      .selectFrom('website_menus')
      .select(['location', 'items', 'version'])
      .where('org_id', '=', context.orgId)
      .orderBy('location')
      .execute();
    const byLocation = new Map(rows.map((row) => [row.location, row] as const));
    return websiteMenuListSchema.parse({
      items: (['header', 'footer'] as const).map((location) => {
        const row = byLocation.get(location);
        return {
          location,
          items: row?.items ?? [],
          version: row?.version ?? 0,
        };
      }),
    });
  });
}

export async function saveWebsiteMenu(
  context: OrgContext,
  bodyInput: unknown,
  runWithOrg: typeof withOrg = withOrg,
) {
  const body = websiteMenuBodySchema.parse(bodyInput);
  const items = body.items.map((item) => websiteMenuItemSchema.parse(item));
  return runWithOrg(context, async (trx) => {
    await authorizeEditor(trx, context);
    const current = await trx
      .selectFrom('website_menus')
      .select(['id', 'version'])
      .where('org_id', '=', context.orgId)
      .where('location', '=', body.location)
      .executeTakeFirst();
    const version = current?.version ?? 0;
    if (version !== body.expectedVersion)
      throw new WebsiteError(
        409,
        'CONFLICT',
        'Website navigation changed in another session. Reload and try again.',
      );
    const saved = current
      ? await trx
          .updateTable('website_menus')
          .set({
            items: JSON.stringify(items) as unknown as Json,
            version: version + 1,
          })
          .where('id', '=', current.id)
          .where('org_id', '=', context.orgId)
          .where('version', '=', version)
          .returning(['id', 'location', 'items', 'version'])
          .executeTakeFirst()
      : await trx
          .insertInto('website_menus')
          .values({
            id: randomUUID(),
            org_id: context.orgId,
            location: body.location,
            items: JSON.stringify(items) as unknown as Json,
            version: 1,
          })
          .onConflict((conflict) =>
            conflict.columns(['org_id', 'location']).doNothing(),
          )
          .returning(['id', 'location', 'items', 'version'])
          .executeTakeFirst();
    if (!saved)
      throw new WebsiteError(409, 'CONFLICT', 'Navigation update conflicted');
    const menu = websiteMenuSchema.parse({
      location: saved.location,
      items: saved.items,
      version: saved.version,
    });
    await appendAuditEvent(trx, context, {
      action: 'website.menu.updated',
      entityType: 'website_menu',
      entityId: saved.id,
      changes: {
        location: { tier: 'internal', after: body.location },
        itemCount: { tier: 'internal', after: menu.items.length },
        version: { tier: 'internal', after: menu.version },
      },
    });
    return { menu };
  });
}

export async function saveWebsitePage(
  context: OrgContext,
  pageId: string | undefined,
  bodyInput: unknown,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  const body = websitePageBodySchema.parse(bodyInput);
  return runWithOrg(context, async (trx) => {
    await authorizeEditor(trx, context);
    const current = pageId
      ? await trx
          .selectFrom('website_pages')
          .selectAll()
          .where('id', '=', pageId)
          .executeTakeFirst()
      : undefined;
    if (pageId && !current)
      throw new WebsiteError(404, 'NOT_FOUND', 'Website page not found');

    if (current) {
      if (body.expectedVersion !== current.version)
        throw new WebsiteError(
          409,
          'CONFLICT',
          'This page changed in another session. Reload and try again.',
        );
      await trx
        .insertInto('website_revisions')
        .values({
          id: randomUUID(),
          org_id: context.orgId,
          page_id: current.id,
          title: current.title,
          blocks: JSON.stringify(current.blocks) as unknown as Json,
          seo: JSON.stringify(current.seo) as unknown as Json,
          created_by: context.actor.accountId,
        })
        .execute();
    } else if (body.expectedVersion !== undefined) {
      throw new WebsiteError(409, 'CONFLICT', 'The page no longer exists');
    }

    const id = current?.id ?? randomUUID();
    const values = {
      slug: body.slug,
      title: body.title,
      blocks: JSON.stringify(body.blocks) as unknown as Json,
      seo: JSON.stringify(body.seo) as unknown as Json,
      status: body.status,
      published_at:
        body.status === 'published' ? (current?.published_at ?? now) : null,
      version: current ? current.version + 1 : 1,
    };
    const row = current
      ? await trx
          .updateTable('website_pages')
          .set(values)
          .where('id', '=', current.id)
          .where('version', '=', current.version)
          .returning([
            'id',
            'slug',
            'title',
            'blocks',
            'seo',
            'status',
            'version',
            'updated_at',
          ])
          .executeTakeFirst()
      : await trx
          .insertInto('website_pages')
          .values({
            id,
            org_id: context.orgId,
            kind: 'content',
            auto_key: null,
            ...values,
          })
          .returning([
            'id',
            'slug',
            'title',
            'blocks',
            'seo',
            'status',
            'version',
            'updated_at',
          ])
          .executeTakeFirst();
    if (!row) throw new WebsiteError(409, 'CONFLICT', 'Page update conflicted');
    const page = pageSummary(row);
    await appendAuditEvent(trx, context, {
      action: current ? 'website.page.updated' : 'website.page.created',
      entityType: 'website_page',
      entityId: page.id,
      changes: {
        slug: {
          tier: 'internal',
          before: current?.slug ?? null,
          after: page.slug,
        },
        title: {
          tier: 'internal',
          before: current?.title ?? null,
          after: page.title,
        },
        status: {
          tier: 'internal',
          before: current?.status ?? null,
          after: page.status,
        },
        version: {
          tier: 'internal',
          before: current?.version ?? null,
          after: page.version,
        },
      },
    });
    return { page };
  });
}

export async function getPublicWebsitePage(
  database: WebsiteDatabase,
  orgSlug: string,
  pageSlug: string,
  runWithOrg: typeof withOrg = withOrg,
) {
  const organization = await database
    .selectFrom('organizations')
    .select(['id', 'slug', 'name', 'default_locale', 'status'])
    .where('slug', '=', orgSlug)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!organization) return null;
  const context = { orgId: organization.id, actor: { accountId: publicActor } };
  return runWithOrg(context, async (trx) => {
    const settings = await trx
      .selectFrom('website_settings')
      .select(['published', 'robots_policy', 'theme'])
      .where('org_id', '=', organization.id)
      .executeTakeFirst();
    if (!settings?.published) return null;
    const page = await trx
      .selectFrom('website_pages')
      .select(['slug', 'title', 'blocks', 'seo'])
      .where('slug', '=', pageSlug)
      .where('status', '=', 'published')
      .executeTakeFirst();
    if (!page) return null;
    const menuRows = await trx
      .selectFrom('website_menus')
      .select(['location', 'items'])
      .where('org_id', '=', organization.id)
      .where('location', 'in', ['header', 'footer'])
      .execute();
    const menus = new Map(menuRows.map((row) => [row.location, row] as const));
    const headerMenu = menus.get('header');
    const footerMenu = menus.get('footer');
    const navigationRows = headerMenu
      ? websiteMenuItemSchema.array().parse(headerMenu.items)
      : await trx
          .selectFrom('website_pages')
          .select(['slug', 'title'])
          .where('status', '=', 'published')
          .orderBy('slug')
          .execute()
          .then((pages) =>
            pages.map(({ slug, title }) => ({
              label: title,
              href:
                slug === 'home'
                  ? `/site/${organization.slug}`
                  : `/site/${organization.slug}/${slug}`,
            })),
          );
    const footerNavigation = footerMenu
      ? websiteMenuItemSchema.array().parse(footerMenu.items)
      : [];
    return websitePublicPageSchema.parse({
      organization: {
        name: organization.name,
        slug: organization.slug,
        locale: organization.default_locale,
      },
      theme: readTheme(settings.theme),
      robotsPolicy: settings.robots_policy,
      page,
      navigation: navigationRows,
      footerNavigation,
    });
  });
}

function readTheme(value: Json): { primary: string; secondary: string } {
  const theme =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value
      : {};
  const primary = 'primary' in theme ? theme.primary : null;
  const secondary = 'secondary' in theme ? theme.secondary : null;
  return {
    primary:
      typeof primary === 'string' && /^#[0-9a-f]{6}$/i.test(primary)
        ? primary
        : '#3a67b2',
    secondary:
      typeof secondary === 'string' && /^#[0-9a-f]{6}$/i.test(secondary)
        ? secondary
        : '#252b2e',
  };
}

export async function listPublicWebsitePages(
  database: WebsiteDatabase,
  orgSlug: string,
  runWithOrg: typeof withOrg = withOrg,
) {
  const organization = await database
    .selectFrom('organizations')
    .select(['id', 'slug'])
    .where('slug', '=', orgSlug)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!organization) return null;
  return runWithOrg(
    { orgId: organization.id, actor: { accountId: publicActor } },
    async (trx) => {
      const settings = await trx
        .selectFrom('website_settings')
        .select(['published', 'robots_policy'])
        .where('org_id', '=', organization.id)
        .executeTakeFirst();
      if (!settings?.published || settings.robots_policy === 'noindex')
        return [];
      return trx
        .selectFrom('website_pages')
        .select(['slug', 'updated_at'])
        .where('status', '=', 'published')
        .orderBy('slug')
        .execute();
    },
  );
}
