import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';

import type { DB, JsonObject } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { EmailSender } from '../../integrations/email/sender';

import { listHelpArticles } from './content';
import type { HelpArticle } from './content';

export class HelpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface HelpArticleSummary {
  slug: string;
  locale: string;
  title: string;
  summary: string;
  category: string;
  audience: string;
}

interface SafeSupportContext extends JsonObject {
  surface: 'portal' | 'console' | 'unknown';
  path: string;
  article?: string;
}

function sanitizeSupportContext(
  input: Record<string, unknown> | undefined,
): SafeSupportContext {
  const rawPath = typeof input?.['path'] === 'string' ? input['path'] : '';
  const pathOnly = rawPath.split(/[?#]/, 1)[0] ?? '';
  const safePath = /^\/(?:console|portal)(?:\/[A-Za-z0-9:_/-]{0,180})?$/.test(
    pathOnly,
  )
    ? pathOnly
        .replace(/\/[0-9a-f-]{36}(?=\/|$)/gi, '/:id')
        .replace(/\/\d{3,}(?=\/|$)/g, '/:id')
    : '/';
  const surface =
    input?.['surface'] === 'portal'
      ? 'portal'
      : input?.['surface'] === 'console'
        ? 'console'
        : 'unknown';
  const article =
    typeof input?.['article'] === 'string' &&
    /^[a-z0-9-]{1,80}$/.test(input['article'])
      ? input['article']
      : null;
  return {
    surface,
    path: safePath,
    ...(article ? { article } : {}),
  };
}

export function createHelpService(
  database: Kysely<DB>,
  email: EmailSender | null,
  supportInbox: string | null,
) {
  const withOrg = createWithOrg(database);

  function catalog(
    locale: string,
    audience?: string,
  ): { articles: HelpArticleSummary[]; categories: string[] } {
    const wanted = ['en', 'es'].includes(locale) ? locale : 'en';
    const all = listHelpArticles();
    const localized = new Map<string, HelpArticle>();
    for (const article of all.filter((item) => item.locale === 'en'))
      localized.set(article.slug, article);
    for (const article of all.filter((item) => item.locale === wanted))
      localized.set(article.slug, article);
    let articles = [...localized.values()];
    if (audience && audience !== 'all')
      articles = articles.filter(
        (article) =>
          article.audience === 'all' || article.audience === audience,
      );
    articles.sort(
      (a, b) => a.order - b.order || a.title.localeCompare(b.title),
    );
    return {
      articles: articles.map((article) => ({
        slug: article.slug,
        locale: article.locale,
        title: article.title,
        summary: article.summary,
        category: article.category,
        audience: article.audience,
      })),
      categories: [...new Set(articles.map((article) => article.category))],
    };
  }

  function getArticle(
    slug: string,
    locale: string,
  ): (HelpArticleSummary & { body: string }) | null {
    const wanted = ['en', 'es'].includes(locale) ? locale : 'en';
    const articles = listHelpArticles().filter(
      (article) => article.slug === slug,
    );
    const article =
      articles.find((item) => item.locale === wanted) ??
      articles.find((item) => item.locale === 'en');
    if (!article) return null;
    return article;
  }

  function search(query: string, locale: string): HelpArticleSummary[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];
    const { articles } = catalog(locale);
    const scored = articles
      .map((article) => {
        const haystack =
          `${article.title} ${article.summary} ${article.category}`.toLowerCase();
        const score = terms.reduce(
          (sum, term) => sum + (haystack.includes(term) ? 1 : 0),
          0,
        );
        return { article, score };
      })
      .filter((entry) => entry.score > 0);
    return scored
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.article);
  }

  async function createSupportRequest(
    orgId: string,
    actorId: string,
    input: {
      kind: 'support' | 'concierge_import';
      subject: string;
      body: string;
      contactEmail?: string | undefined;
      context?: Record<string, unknown> | undefined;
    },
  ): Promise<{ id: string }> {
    return withOrg({ orgId, actor: { accountId: actorId } }, async (trx) => {
      const member = await trx
        .selectFrom('org_memberships')
        .select('id')
        .where('org_id', '=', orgId)
        .where('account_id', '=', actorId)
        .where('status', '=', 'active')
        .executeTakeFirst();
      const familyLink = member
        ? null
        : await trx
            .selectFrom('person_account_links')
            .select('id')
            .where('org_id', '=', orgId)
            .where('account_id', '=', actorId)
            .where('verified_at', 'is not', null)
            .where('revoked_at', 'is', null)
            .executeTakeFirst();
      if (!member && (!familyLink || input.kind === 'concierge_import'))
        throw new HelpError(404, 'NOT_FOUND', 'Organization not found');
      if (!email || !supportInbox)
        throw new HelpError(
          503,
          'SUPPORT_UNAVAILABLE',
          'Support notifications are not configured. Try again later.',
        );
      const safeContext = sanitizeSupportContext(input.context);
      const id = newId();
      await trx
        .insertInto('support_requests')
        .values({
          id,
          org_id: orgId,
          kind: input.kind,
          subject: input.subject.slice(0, 200),
          body: input.body.slice(0, 10_000),
          contact_email: input.contactEmail ?? null,
          created_by: actorId,
          context: safeContext,
        })
        .execute();
      try {
        const org = await trx
          .selectFrom('organizations')
          .select('name')
          .where('id', '=', orgId)
          .executeTakeFirst();
        const account = await trx
          .selectFrom('accounts')
          .select('email')
          .where('id', '=', actorId)
          .executeTakeFirst();
        await email.send({
          to: supportInbox,
          subject: `[Athlentry ${input.kind}] ${input.subject}`,
          text:
            `Organization: ${org?.name ?? orgId}\n` +
            `From: ${input.contactEmail ?? account?.email ?? 'unknown'}\n` +
            `Request: ${id}\n` +
            `Surface: ${safeContext.surface}\n` +
            `Route: ${safeContext.path}\n\n${input.body}`,
        });
        await trx
          .updateTable('support_requests')
          .set({ status: 'sent', notified_at: new Date() })
          .where('org_id', '=', orgId)
          .where('id', '=', id)
          .execute();
      } catch {
        await trx
          .updateTable('support_requests')
          .set({ status: 'failed' })
          .where('org_id', '=', orgId)
          .where('id', '=', id)
          .execute();
        throw new HelpError(
          503,
          'SUPPORT_DELIVERY_FAILED',
          'Support notification could not be sent. Try again later.',
        );
      }
      return { id };
    });
  }

  return { catalog, getArticle, search, createSupportRequest };
}

export type HelpService = ReturnType<typeof createHelpService>;
