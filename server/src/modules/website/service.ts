import { randomBytes, randomUUID } from 'node:crypto';
import { lookup as lookupHost, resolveTxt } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  checkServerIdentity as checkTlsServerIdentity,
  connect as tlsConnect,
} from 'node:tls';
import { domainToASCII } from 'node:url';

import {
  websiteMenuBodySchema,
  websiteMenuListSchema,
  websiteMenuSchema,
  websiteMenuItemSchema,
  websiteDomainCreateSchema,
  websiteDomainListSchema,
  websiteDomainSchema,
  websiteEmbedBodySchema,
  websiteEmbedConfigSchema,
  websiteEmbedListSchema,
  websiteEmbedSchema,
  websitePublicEmbedSchema,
  websiteNewsBodySchema,
  websiteNewsListSchema,
  websiteNewsPostSchema,
  websiteNewsSaveResponseSchema,
  websitePublicNewsSchema,
  websitePageBodySchema,
  websitePageListSchema,
  websitePageSchema,
  websitePublicPageSchema,
  websiteSettingsBodySchema,
  websiteSettingsSchema,
} from '@shared/schemas/website';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { DB, Json } from '../../db/types';
import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { appendAuditEvent } from '../audit/service';
import { getStandings } from '../standings/service';

import { isPublicWebsiteDomainAddress } from './domain-security';
import { WebsiteError, requireWebsiteEditor } from './policy';

const publicActor = '00000000-0000-0000-0000-000000000000';
const publicProgramStatuses = [
  'published',
  'registration_open',
  'registration_closed',
  'in_progress',
  'completed',
] as const;
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

function newsPostSummary(row: {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  body_html: string;
  status: string;
  published_at: Date | null;
  version: number;
  updated_at: Date;
}) {
  return websiteNewsPostSchema.parse({
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    bodyText: row.body_html,
    status: row.status,
    publishedAt: row.published_at?.toISOString() ?? null,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  });
}

export async function listWebsiteNews(
  context: OrgContext,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await authorizeEditor(trx, context);
    const rows = await trx
      .selectFrom('news_posts')
      .select([
        'id',
        'slug',
        'title',
        'excerpt',
        'body_html',
        'status',
        'published_at',
        'version',
        'updated_at',
      ])
      .orderBy('updated_at', 'desc')
      .execute();
    return websiteNewsListSchema.parse({ items: rows.map(newsPostSummary) });
  });
}

export async function saveWebsiteNews(
  context: OrgContext,
  postId: string | undefined,
  bodyInput: unknown,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  const body = websiteNewsBodySchema.parse(bodyInput);
  return runWithOrg(context, async (trx) => {
    await authorizeEditor(trx, context);
    const current = postId
      ? await trx
          .selectFrom('news_posts')
          .selectAll()
          .where('id', '=', postId)
          .executeTakeFirst()
      : undefined;
    if (postId && !current)
      throw new WebsiteError(404, 'NOT_FOUND', 'News post not found');
    if (current && body.expectedVersion !== current.version)
      throw new WebsiteError(
        409,
        'CONFLICT',
        'This news post changed in another session. Reload and try again.',
      );
    if (!current && body.expectedVersion !== undefined)
      throw new WebsiteError(409, 'CONFLICT', 'The news post no longer exists');

    const saved = current
      ? await trx
          .updateTable('news_posts')
          .set({
            slug: body.slug,
            title: body.title,
            excerpt: body.excerpt,
            body_html: body.bodyText,
            status: body.status,
            published_at:
              body.status === 'published'
                ? (current.published_at ?? now)
                : null,
            version: current.version + 1,
          })
          .where('org_id', '=', context.orgId)
          .where('id', '=', current.id)
          .where('version', '=', current.version)
          .returning([
            'id',
            'slug',
            'title',
            'excerpt',
            'body_html',
            'status',
            'published_at',
            'version',
            'updated_at',
          ])
          .executeTakeFirst()
      : await trx
          .insertInto('news_posts')
          .values({
            id: randomUUID(),
            org_id: context.orgId,
            slug: body.slug,
            title: body.title,
            excerpt: body.excerpt,
            body_html: body.bodyText,
            author_account_id: context.actor.accountId,
            status: body.status,
            published_at: body.status === 'published' ? now : null,
          })
          .returning([
            'id',
            'slug',
            'title',
            'excerpt',
            'body_html',
            'status',
            'published_at',
            'version',
            'updated_at',
          ])
          .executeTakeFirst();
    if (!saved)
      throw new WebsiteError(409, 'CONFLICT', 'News post update conflicted');

    const post = newsPostSummary(saved);
    await appendAuditEvent(trx, context, {
      action: current ? 'website.news.updated' : 'website.news.created',
      entityType: 'website_news_post',
      entityId: post.id,
      changes: {
        slug: {
          tier: 'internal',
          before: current?.slug ?? null,
          after: post.slug,
        },
        title: {
          tier: 'internal',
          before: current?.title ?? null,
          after: post.title,
        },
        status: {
          tier: 'internal',
          before: current?.status ?? null,
          after: post.status,
        },
        version: {
          tier: 'internal',
          before: current?.version ?? null,
          after: post.version,
        },
      },
    });
    return websiteNewsSaveResponseSchema.parse({ post });
  });
}

export async function listPublicWebsiteNews(
  database: WebsiteDatabase,
  orgSlug: string,
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
    const [posts, menus] = await Promise.all([
      trx
        .selectFrom('news_posts')
        .select(['slug', 'title', 'excerpt', 'body_html', 'published_at'])
        .where('org_id', '=', organization.id)
        .where('status', '=', 'published')
        .orderBy('published_at', 'desc')
        .limit(50)
        .execute(),
      trx
        .selectFrom('website_menus')
        .select(['location', 'items'])
        .where('org_id', '=', organization.id)
        .execute(),
    ]);
    const byLocation = new Map(
      menus.map(
        (menu) =>
          [
            menu.location,
            websiteMenuItemSchema.array().parse(menu.items),
          ] as const,
      ),
    );
    const newsPath = `/site/${organization.slug}/news`;
    const headerNavigation = byLocation.get('header') ?? [];
    const navigation =
      posts.length === 0 ||
      headerNavigation.some((item) => item.href === newsPath)
        ? headerNavigation
        : [
            {
              label: organization.default_locale === 'es' ? 'Noticias' : 'News',
              href: newsPath,
            },
            ...headerNavigation,
          ];
    return websitePublicNewsSchema.parse({
      organization: {
        slug: organization.slug,
        name: organization.name,
        locale: organization.default_locale,
      },
      theme: readTheme(settings.theme),
      robotsPolicy: settings.robots_policy,
      navigation,
      footerNavigation: byLocation.get('footer') ?? [],
      posts: posts.map((post) => ({
        slug: post.slug,
        title: post.title,
        excerpt: post.excerpt,
        bodyText: post.body_html,
        publishedAt: post.published_at?.toISOString() ?? null,
      })),
    });
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
  if (
    ['news', 'programs', 'schedule'].some(
      (reserved) =>
        body.slug === reserved || body.slug.startsWith(`${reserved}/`),
    )
  )
    throw new WebsiteError(
      409,
      'CONFLICT',
      'This path is reserved for an automatically generated public page.',
    );
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

async function getPublicWebsiteChrome(
  database: WebsiteDatabase,
  orgSlug: string,
  runWithOrg: typeof withOrg,
) {
  const organization = await database
    .selectFrom('organizations')
    .select(['id', 'slug', 'name', 'default_locale', 'status'])
    .where('slug', '=', orgSlug)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!organization) return null;

  const context = {
    orgId: organization.id,
    actor: { accountId: publicActor },
  };
  const website = await runWithOrg(context, async (trx) => {
    const settings = await trx
      .selectFrom('website_settings')
      .select(['published', 'robots_policy', 'theme'])
      .executeTakeFirst();
    if (!settings?.published) return null;

    const menuRows = await trx
      .selectFrom('website_menus')
      .select(['location', 'items'])
      .where('location', 'in', ['header', 'footer'])
      .execute();
    const menus = new Map(menuRows.map((row) => [row.location, row] as const));
    const headerMenu = menus.get('header');
    const footerMenu = menus.get('footer');
    const locale = organization.default_locale;
    const generatedNavigation = [
      {
        label: locale === 'es' ? 'Programas' : 'Programs',
        href: `/site/${organization.slug}/programs`,
      },
      {
        label: locale === 'es' ? 'Calendario' : 'Schedule',
        href: `/site/${organization.slug}/schedule`,
      },
      {
        label: locale === 'es' ? 'Noticias' : 'News',
        href: `/site/${organization.slug}/news`,
      },
    ];
    const configuredNavigation = headerMenu
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
    const navigation = [...configuredNavigation];
    for (const item of generatedNavigation) {
      if (!navigation.some((configured) => configured.href === item.href))
        navigation.push(item);
    }

    return {
      theme: readTheme(settings.theme),
      robotsPolicy: settings.robots_policy,
      navigation,
      footerNavigation: footerMenu
        ? websiteMenuItemSchema.array().parse(footerMenu.items)
        : generatedNavigation,
    };
  });
  if (!website) return null;
  return {
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      locale: organization.default_locale,
    },
    ...website,
  };
}

function publicProgramDate(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : value.slice(0, 10);
}

export async function getPublicWebsitePrograms(
  database: WebsiteDatabase,
  orgSlug: string,
  runWithOrg: typeof withOrg = withOrg,
) {
  const site = await getPublicWebsiteChrome(database, orgSlug, runWithOrg);
  if (!site) return null;
  const programs = await runWithOrg(
    { orgId: site.organization.id, actor: { accountId: publicActor } },
    (trx) =>
      trx
        .selectFrom('programs as program')
        .innerJoin('seasons as season', (join) =>
          join
            .onRef('season.org_id', '=', 'program.org_id')
            .onRef('season.id', '=', 'program.season_id'),
        )
        .select([
          'program.id',
          'program.slug',
          'program.name',
          'program.mode',
          'program.status',
          'program.starts_on',
          'program.ends_on',
          'season.name as seasonName',
        ])
        .where('program.org_id', '=', site.organization.id)
        .where('program.visibility', '=', 'public')
        .where('program.status', 'in', publicProgramStatuses)
        .orderBy('program.starts_on', 'asc')
        .orderBy('program.name', 'asc')
        .limit(200)
        .execute(),
  );
  return {
    ...site,
    programs: programs.map((program) => ({
      slug: program.slug,
      name: program.name,
      mode: program.mode,
      status: program.status,
      startsOn: publicProgramDate(program.starts_on),
      endsOn: publicProgramDate(program.ends_on),
      seasonName: program.seasonName,
    })),
  };
}

export async function getPublicWebsiteProgram(
  database: WebsiteDatabase,
  orgSlug: string,
  programSlug: string,
  runWithOrg: typeof withOrg = withOrg,
) {
  const site = await getPublicWebsiteChrome(database, orgSlug, runWithOrg);
  if (!site) return null;
  const program = await runWithOrg(
    { orgId: site.organization.id, actor: { accountId: publicActor } },
    (trx) =>
      trx
        .selectFrom('programs as program')
        .innerJoin('seasons as season', (join) =>
          join
            .onRef('season.org_id', '=', 'program.org_id')
            .onRef('season.id', '=', 'program.season_id'),
        )
        .select([
          'program.id',
          'program.slug',
          'program.name',
          'program.mode',
          'program.status',
          'program.starts_on',
          'program.ends_on',
          'season.name as seasonName',
        ])
        .where('program.org_id', '=', site.organization.id)
        .where('program.slug', '=', programSlug)
        .where('program.visibility', '=', 'public')
        .where('program.status', 'in', publicProgramStatuses)
        .executeTakeFirst(),
  );
  if (!program) return null;
  const publicOfferings = await runWithOrg(
    { orgId: site.organization.id, actor: { accountId: publicActor } },
    (trx) =>
      trx
        .selectFrom('registration_offerings')
        .select('id')
        .where('program_id', '=', program.id)
        .where('visibility', '=', 'public')
        .where('active', '=', true)
        .limit(1)
        .executeTakeFirst(),
  );
  return {
    ...site,
    program: {
      slug: program.slug,
      name: program.name,
      mode: program.mode,
      status: program.status,
      startsOn: publicProgramDate(program.starts_on),
      endsOn: publicProgramDate(program.ends_on),
      seasonName: program.seasonName,
      registrationAvailable:
        program.status === 'registration_open' && Boolean(publicOfferings),
    },
  };
}

export async function getPublicWebsiteSchedule(
  database: WebsiteDatabase,
  orgSlug: string,
  runWithOrg: typeof withOrg = withOrg,
  now = new Date(),
) {
  const site = await getPublicWebsiteChrome(database, orgSlug, runWithOrg);
  if (!site) return null;
  const events = await runWithOrg(
    { orgId: site.organization.id, actor: { accountId: publicActor } },
    (trx) =>
      trx
        .selectFrom('events as event')
        .innerJoin('programs as program', (join) =>
          join
            .onRef('program.org_id', '=', 'event.org_id')
            .onRef('program.id', '=', 'event.program_id'),
        )
        .select([
          'event.id',
          'event.title',
          'event.starts_at',
          'event.ends_at',
          'event.timezone',
          'event.location_text',
          'event.status',
          'program.name as programName',
        ])
        .where('event.org_id', '=', site.organization.id)
        .where('event.published', '=', true)
        .where('event.status', 'in', ['scheduled', 'postponed'])
        .where('event.starts_at', '>=', now)
        .where('program.org_id', '=', site.organization.id)
        .where('program.visibility', '=', 'public')
        .where('program.status', 'in', publicProgramStatuses)
        .orderBy('event.starts_at', 'asc')
        .limit(200)
        .execute(),
  );
  return {
    ...site,
    events: events.map((event) => ({
      id: event.id,
      title: event.title,
      startsAt: event.starts_at.toISOString(),
      endsAt: event.ends_at.toISOString(),
      timezone: event.timezone,
      location: event.location_text,
      status: event.status,
      programName: event.programName,
    })),
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

type WebsiteDomainRow = {
  id: string;
  host: string;
  status: string;
  verify_token: string;
  is_primary: boolean;
  verified_at: Date | null;
  last_checked_at: Date | null;
  check_detail: string | null;
  version: number;
  updated_at: Date;
};

function domainSummary(row: WebsiteDomainRow) {
  return websiteDomainSchema.parse({
    id: row.id,
    host: row.host,
    status: row.status,
    isPrimary: row.is_primary,
    verificationRecordName: `_athlentry-verification.${row.host}`,
    verificationToken:
      row.status === 'active' || row.status === 'disabled'
        ? null
        : row.verify_token,
    verifiedAt: row.verified_at?.toISOString() ?? null,
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    statusNote: row.check_detail,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  });
}

export async function listWebsiteDomains(
  context: OrgContext,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await authorizeEditor(trx, context);
    const rows = await trx
      .selectFrom('site_domains')
      .select([
        'id',
        'host',
        'status',
        'verify_token',
        'is_primary',
        'verified_at',
        'last_checked_at',
        'check_detail',
        'version',
        'updated_at',
      ])
      .orderBy('created_at', 'asc')
      .execute();
    return websiteDomainListSchema.parse({ items: rows.map(domainSummary) });
  });
}

export async function addWebsiteDomain(
  context: OrgContext,
  bodyInput: unknown,
  reservedHost: string,
  runWithOrg: typeof withOrg = withOrg,
) {
  const { host } = websiteDomainCreateSchema.parse(bodyInput);
  const asciiHost = domainToASCII(host);
  const normalizedReservedHost = domainToASCII(reservedHost.toLowerCase());
  if (
    !asciiHost ||
    isIP(asciiHost) !== 0 ||
    asciiHost === normalizedReservedHost ||
    asciiHost.endsWith(`.${normalizedReservedHost}`)
  )
    throw new WebsiteError(
      409,
      'CONFLICT',
      'Use a custom hostname outside the Athlentry app domain',
    );

  return runWithOrg(context, async (trx) => {
    await authorizeEditor(trx, context);
    const id = randomUUID();
    const verifyToken = randomBytes(32).toString('base64url');
    let row: WebsiteDomainRow | undefined;
    try {
      row = await trx
        .insertInto('site_domains')
        .values({
          id,
          org_id: context.orgId,
          host: asciiHost,
          kind: 'custom',
          status: 'pending',
          verify_token: verifyToken,
          verification_method: 'txt',
        })
        .returning([
          'id',
          'host',
          'status',
          'verify_token',
          'is_primary',
          'verified_at',
          'last_checked_at',
          'check_detail',
          'version',
          'updated_at',
        ])
        .executeTakeFirst();
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      )
        throw new WebsiteError(
          409,
          'CONFLICT',
          'This custom domain is already assigned to an organization',
        );
      throw error;
    }
    if (!row)
      throw new WebsiteError(409, 'CONFLICT', 'Domain creation conflicted');
    const domain = domainSummary(row);
    await appendAuditEvent(trx, context, {
      action: 'website.domain.created',
      entityType: 'website_domain',
      entityId: domain.id,
      changes: {
        host: { tier: 'internal', before: null, after: domain.host },
        status: { tier: 'internal', before: null, after: domain.status },
      },
    });
    return { domain };
  });
}

type TxtLookup = (name: string) => Promise<string[][]>;
type CertificateProbe = (host: string) => Promise<boolean>;

async function trustedCertificateIsReady(host: string): Promise<boolean> {
  const addresses = await lookupHost(host, { all: true, verbatim: true }).catch(
    () => [],
  );
  const target = addresses.find(({ address }) =>
    isPublicWebsiteDomainAddress(address),
  );
  if (!target) return false;

  return new Promise((resolve) => {
    const socket = tlsConnect({
      host: target.address,
      port: 443,
      servername: host,
      checkServerIdentity: (_servername, certificate) =>
        checkTlsServerIdentity(host, certificate),
      rejectUnauthorized: true,
      timeout: 5000,
    });
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.once('secureConnect', () => {
      finish(socket.authorized);
    });
    socket.once('timeout', () => {
      finish(false);
    });
    socket.once('error', () => {
      finish(false);
    });
  });
}

export async function verifyWebsiteDomain(
  context: OrgContext,
  domainId: string,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
  lookupTxt: TxtLookup = resolveTxt,
  certificateProbe: CertificateProbe = trustedCertificateIsReady,
) {
  const current = await runWithOrg(context, async (trx) => {
    await authorizeEditor(trx, context);
    return trx
      .selectFrom('site_domains')
      .select([
        'id',
        'host',
        'status',
        'verify_token',
        'is_primary',
        'verified_at',
        'last_checked_at',
        'check_detail',
        'version',
        'updated_at',
      ])
      .where('id', '=', domainId)
      .executeTakeFirst();
  });
  if (!current)
    throw new WebsiteError(404, 'NOT_FOUND', 'Website domain not found');
  if (current.status === 'disabled')
    throw new WebsiteError(
      409,
      'CONFLICT',
      'Disabled domains cannot be checked',
    );

  const recordName = `_athlentry-verification.${current.host}`;
  let txtMatches = false;
  try {
    const records = await lookupTxt(recordName);
    txtMatches = records.some(
      (parts) => parts.join('') === current.verify_token,
    );
  } catch {
    txtMatches = false;
  }
  const tlsReady = txtMatches ? await certificateProbe(current.host) : false;
  const nextStatus = tlsReady ? 'active' : txtMatches ? 'verifying' : 'failed';
  const statusNote = tlsReady
    ? 'Ownership and TLS certificate verified.'
    : txtMatches
      ? 'Ownership verified; waiting for a trusted TLS certificate.'
      : 'The ownership TXT record was not found or did not match.';

  return runWithOrg(context, async (trx) => {
    await authorizeEditor(trx, context);
    const row = await trx
      .updateTable('site_domains')
      .set({
        status: nextStatus,
        verified_at: txtMatches ? (current.verified_at ?? now) : null,
        last_checked_at: now,
        check_detail: statusNote,
        version: current.version + 1,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', domainId)
      .where('version', '=', current.version)
      .where('status', '!=', 'disabled')
      .returning([
        'id',
        'host',
        'status',
        'verify_token',
        'is_primary',
        'verified_at',
        'last_checked_at',
        'check_detail',
        'version',
        'updated_at',
      ])
      .executeTakeFirst();
    if (!row)
      throw new WebsiteError(
        409,
        'CONFLICT',
        'The domain changed while DNS verification was running. Reload and retry.',
      );
    await appendAuditEvent(trx, context, {
      action: 'website.domain.verified',
      entityType: 'website_domain',
      entityId: domainId,
      changes: {
        status: {
          tier: 'internal',
          before: current.status,
          after: nextStatus,
        },
      },
    });
    return { domain: domainSummary(row) };
  });
}

export async function setPrimaryWebsiteDomain(
  context: OrgContext,
  domainId: string,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await authorizeEditor(trx, context);
    const row = await trx
      .selectFrom('site_domains')
      .select([
        'id',
        'host',
        'status',
        'verify_token',
        'is_primary',
        'verified_at',
        'last_checked_at',
        'check_detail',
        'version',
        'updated_at',
      ])
      .where('id', '=', domainId)
      .executeTakeFirst();
    if (!row)
      throw new WebsiteError(404, 'NOT_FOUND', 'Website domain not found');
    if (row.status !== 'active')
      throw new WebsiteError(
        409,
        'CONFLICT',
        'A domain must have verified ownership and TLS before it can be primary',
      );
    await trx
      .updateTable('site_domains')
      .set({ is_primary: false, version: sql`version + 1` })
      .where('org_id', '=', context.orgId)
      .where('is_primary', '=', true)
      .execute();
    const updated = await trx
      .updateTable('site_domains')
      .set({ is_primary: true, version: sql`version + 1` })
      .where('org_id', '=', context.orgId)
      .where('id', '=', domainId)
      .where('status', '=', 'active')
      .returning([
        'id',
        'host',
        'status',
        'verify_token',
        'is_primary',
        'verified_at',
        'last_checked_at',
        'check_detail',
        'version',
        'updated_at',
      ])
      .executeTakeFirst();
    if (!updated)
      throw new WebsiteError(409, 'CONFLICT', 'Domain activation changed');
    await appendAuditEvent(trx, context, {
      action: 'website.domain.primary_changed',
      entityType: 'website_domain',
      entityId: domainId,
      changes: {
        isPrimary: { tier: 'internal', before: false, after: true },
      },
    });
    return { domain: domainSummary(updated) };
  });
}

export async function disableWebsiteDomain(
  context: OrgContext,
  domainId: string,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await authorizeEditor(trx, context);
    const current = await trx
      .selectFrom('site_domains')
      .select(['id', 'status', 'is_primary', 'version'])
      .where('id', '=', domainId)
      .executeTakeFirst();
    if (!current || current.status === 'disabled')
      throw new WebsiteError(404, 'NOT_FOUND', 'Website domain not found');
    const row = await trx
      .updateTable('site_domains')
      .set({
        status: 'disabled',
        is_primary: false,
        check_detail: 'Disabled by an organization website editor.',
        version: sql`version + 1`,
      })
      .where('org_id', '=', context.orgId)
      .where('id', '=', domainId)
      .where('version', '=', current.version)
      .where('status', '!=', 'disabled')
      .returning([
        'id',
        'host',
        'status',
        'verify_token',
        'is_primary',
        'verified_at',
        'last_checked_at',
        'check_detail',
        'version',
        'updated_at',
      ])
      .executeTakeFirst();
    if (!row)
      throw new WebsiteError(
        409,
        'CONFLICT',
        'The domain changed. Reload and retry.',
      );
    await appendAuditEvent(trx, context, {
      action: 'website.domain.disabled',
      entityType: 'website_domain',
      entityId: domainId,
      changes: {
        status: {
          tier: 'internal',
          before: current.status,
          after: 'disabled',
        },
        isPrimary: {
          tier: 'internal',
          before: current.is_primary,
          after: false,
        },
      },
    });
    return { domain: domainSummary(row) };
  });
}

function embedSummary(row: {
  id: string;
  public_key: string;
  config: Json;
  version: number;
  updated_at: Date;
}) {
  return websiteEmbedSchema.parse({
    id: row.id,
    publicKey: row.public_key,
    config: row.config,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  });
}

export async function listWebsiteEmbeds(
  context: OrgContext,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    await authorizeEditor(trx, context);
    const rows = await trx
      .selectFrom('embed_widgets')
      .select(['id', 'public_key', 'config', 'version', 'updated_at'])
      .orderBy('created_at', 'asc')
      .execute();
    return websiteEmbedListSchema.parse({ items: rows.map(embedSummary) });
  });
}

export async function saveWebsiteEmbed(
  context: OrgContext,
  embedId: string | undefined,
  bodyInput: unknown,
  runWithOrg: typeof withOrg = withOrg,
) {
  const body = websiteEmbedBodySchema.parse(bodyInput);
  return runWithOrg(context, async (trx) => {
    await authorizeEditor(trx, context);
    const current = embedId
      ? await trx
          .selectFrom('embed_widgets')
          .select(['id', 'public_key', 'config', 'version', 'updated_at'])
          .where('id', '=', embedId)
          .executeTakeFirst()
      : undefined;
    if (embedId && !current)
      throw new WebsiteError(404, 'NOT_FOUND', 'Website widget not found');
    if (current && body.expectedVersion !== current.version)
      throw new WebsiteError(
        409,
        'CONFLICT',
        'This widget changed in another session. Reload and try again.',
      );
    if (!current && body.expectedVersion !== undefined)
      throw new WebsiteError(409, 'CONFLICT', 'The widget no longer exists');

    const saved = current
      ? await trx
          .updateTable('embed_widgets')
          .set({
            kind: body.config.kind,
            config: body.config,
            version: current.version + 1,
          })
          .where('org_id', '=', context.orgId)
          .where('id', '=', current.id)
          .where('version', '=', current.version)
          .returning(['id', 'public_key', 'config', 'version', 'updated_at'])
          .executeTakeFirst()
      : await trx
          .insertInto('embed_widgets')
          .values({
            id: randomUUID(),
            org_id: context.orgId,
            kind: body.config.kind,
            public_key: randomBytes(32).toString('base64url'),
            config: body.config,
          })
          .returning(['id', 'public_key', 'config', 'version', 'updated_at'])
          .executeTakeFirst();
    if (!saved)
      throw new WebsiteError(409, 'CONFLICT', 'Widget update conflicted');
    const embed = embedSummary(saved);
    await appendAuditEvent(trx, context, {
      action: current ? 'website.embed.updated' : 'website.embed.created',
      entityType: 'website_embed',
      entityId: embed.id,
      changes: {
        kind: {
          tier: 'internal',
          before: current
            ? websiteEmbedSchema.parse({
                id: current.id,
                publicKey: current.public_key,
                config: current.config,
                version: current.version,
                updatedAt: current.updated_at.toISOString(),
              }).config.kind
            : null,
          after: embed.config.kind,
        },
        version: {
          tier: 'internal',
          before: current?.version ?? null,
          after: embed.version,
        },
      },
    });
    return { embed };
  });
}

const publicEmbedStandingsSchema = z.object({
  rows: z.array(
    z.object({
      rank: z.number(),
      teamId: z.string().min(1),
      wins: z.number(),
      losses: z.number(),
      ties: z.number(),
      points: z.number(),
    }),
  ),
  teamNames: z.record(z.string(), z.string()),
});

export async function getPublicWebsiteEmbed(
  database: WebsiteDatabase,
  orgSlug: string,
  publicKey: string,
  runWithOrg: typeof withOrg = withOrg,
  now = new Date(),
) {
  const organization = await database
    .selectFrom('organizations')
    .select(['id', 'slug', 'name', 'status'])
    .where('slug', '=', orgSlug)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!organization) return null;
  const context = {
    orgId: organization.id,
    actor: { accountId: publicActor },
  };
  const widget = await runWithOrg(context, async (trx) => {
    const settings = await trx
      .selectFrom('website_settings')
      .select('published')
      .executeTakeFirst();
    if (!settings?.published) return null;
    const row = await trx
      .selectFrom('embed_widgets')
      .select(['kind', 'config'])
      .where('org_id', '=', organization.id)
      .where('public_key', '=', publicKey)
      .executeTakeFirst();
    if (!row) return null;
    const config = websiteEmbedConfigSchema.parse(row.config);
    return config.kind === row.kind ? config : null;
  });
  if (!widget) return null;

  let program: { slug: string; name: string } | null = null;
  let items: {
    label: string;
    href: string;
    detail: string | null;
  }[] = [];
  if (widget.kind === 'program_list') {
    const programs = await runWithOrg(context, (trx) =>
      trx
        .selectFrom('programs')
        .select(['slug', 'name', 'starts_on', 'ends_on'])
        .where('visibility', '=', 'public')
        .where('status', 'in', publicProgramStatuses)
        .orderBy('starts_on', 'asc')
        .limit(widget.limit)
        .execute(),
    );
    items = programs.map((item) => ({
      label: item.name,
      href: `/site/${organization.slug}/programs/${item.slug}`,
      detail: `${String(item.starts_on)} – ${String(item.ends_on)}`,
    }));
  } else if (widget.kind === 'schedule') {
    const events = await runWithOrg(context, (trx) => {
      let query = trx
        .selectFrom('events')
        .select(['id', 'title', 'starts_at', 'location_text'])
        .where('published', '=', true)
        .where('status', '!=', 'canceled')
        .where('starts_at', '>=', now)
        .orderBy('starts_at', 'asc')
        .limit(widget.limit);
      if (widget.programId)
        query = query.where('program_id', '=', widget.programId);
      return query.execute();
    });
    items = events.map((event) => ({
      label: event.title,
      href: `/site/${organization.slug}/schedule#${event.id}`,
      detail: [event.starts_at.toISOString(), event.location_text]
        .filter((value): value is string => Boolean(value))
        .join(' · '),
    }));
  } else if (widget.kind === 'standings') {
    const publicProgram = await runWithOrg(context, (trx) =>
      trx
        .selectFrom('programs')
        .select(['id', 'slug', 'name'])
        .where('id', '=', widget.programId)
        .where('visibility', '=', 'public')
        .where('status', 'in', publicProgramStatuses)
        .executeTakeFirst(),
    );
    if (!publicProgram) return null;
    program = { slug: publicProgram.slug, name: publicProgram.name };
    const standings = publicEmbedStandingsSchema.parse(
      await getStandings(context, { programId: publicProgram.id }, true),
    );
    items = standings.rows.map((row) => ({
      label: `${String(row.rank)}. ${standings.teamNames[row.teamId] ?? 'Team'}`,
      href: `/site/${organization.slug}/standings/${publicProgram.slug}`,
      detail: `${String(row.wins)}–${String(row.losses)}–${String(row.ties)} · ${String(row.points)} points`,
    }));
  } else {
    const publicProgram = await runWithOrg(context, (trx) =>
      trx
        .selectFrom('programs')
        .select(['id', 'slug', 'name'])
        .where('slug', '=', widget.programSlug)
        .where('visibility', '=', 'public')
        .where('status', 'in', publicProgramStatuses)
        .executeTakeFirst(),
    );
    if (publicProgram) {
      program = { slug: publicProgram.slug, name: publicProgram.name };
      items = [
        {
          label: widget.label,
          href: `/portal/orgs/${organization.id}/register`,
          detail: publicProgram.name,
        },
      ];
    }
  }

  return websitePublicEmbedSchema.parse({
    organization: { slug: organization.slug, name: organization.name },
    config: widget,
    program,
    items,
  });
}
