import { randomUUID } from 'node:crypto';

import {
  websitePageBodySchema,
  websitePageListSchema,
  websitePageSchema,
  websitePublicPageSchema,
} from '@shared/schemas/website';
import type { Kysely } from 'kysely';

import type { DB, Json } from '../../db/types';
import { withOrg } from '../../db/withOrg';
import type { OrgContext, OrgTransaction } from '../../db/withOrg';
import { appendAuditEvent } from '../audit/service';

import { WebsiteError, requireWebsiteEditor } from './policy';

const publicActor = '00000000-0000-0000-0000-000000000000';
type WebsiteDatabase = Kysely<DB>;

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
    const navigationRows = await trx
      .selectFrom('website_pages')
      .select(['slug', 'title'])
      .where('status', '=', 'published')
      .orderBy('slug')
      .execute();
    return websitePublicPageSchema.parse({
      organization: {
        name: organization.name,
        slug: organization.slug,
        locale: organization.default_locale,
      },
      theme: readTheme(settings.theme),
      robotsPolicy: settings.robots_policy,
      page,
      navigation: navigationRows.map(({ slug, title }) => ({ slug, title })),
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
