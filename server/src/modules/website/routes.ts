import { createHash } from 'node:crypto';

import { apiErrorSchema } from '@shared/schemas/errors';
import { orgSlugSchema } from '@shared/schemas/orgs';
import {
  websiteContactReadResponseSchema,
  websiteContactSubmissionBodySchema,
  websiteContactSubmissionListSchema,
  websiteContactSubmissionResponseSchema,
  websiteMenuBodySchema,
  websiteDomainCreateSchema,
  websiteDomainListSchema,
  websiteDomainResponseSchema,
  websiteEmbedBodySchema,
  websiteEmbedListSchema,
  websiteEmbedResponseSchema,
  websiteMenuListSchema,
  websiteMenuResponseSchema,
  websiteNewsBodySchema,
  websiteNewsListSchema,
  websiteNewsSaveResponseSchema,
  websitePageBodySchema,
  websitePageListSchema,
  websitePageSlugSchema,
  websitePublicEmbedSchema,
  websitePublicFacilitiesSchema,
  websitePublicPageSchema,
  websiteSaveResponseSchema,
  websiteSettingsBodySchema,
  websiteSettingsResponseSchema,
} from '@shared/schemas/website';
import express from 'express';
import { z } from 'zod';

import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import type { AuthDependencies } from '../auth/routes';
import { requireSession } from '../auth/routes';

import { WebsiteError } from './policy';
import { publicPlansSchema } from './schema';
import {
  addWebsiteDomain,
  disableWebsiteDomain,
  getPublicWebsiteEmbed,
  getPublicWebsiteFacilities,
  getPublicWebsiteFundraisers,
  getPublicWebsitePage,
  getPublicWebsitePrograms,
  getPublicWebsiteRobotsPolicy,
  getWebsiteSettings,
  listPublicWebsitePlans,
  listPublicWebsiteNews,
  listPublicWebsitePages,
  listWebsiteContactSubmissions,
  listWebsiteMenus,
  listWebsitePages,
  listWebsiteNews,
  listWebsiteDomains,
  listWebsiteEmbeds,
  saveWebsiteMenu,
  saveWebsitePage,
  saveWebsiteNews,
  saveWebsiteSettings,
  saveWebsiteEmbed,
  createPublicWebsiteContactSubmission,
  markWebsiteContactSubmissionsRead,
  setPrimaryWebsiteDomain,
  verifyWebsiteDomain,
} from './service';

const pageIdSchema = z.uuid();
const domainIdSchema = z.uuid();
const emptyBodySchema = z.strictObject({});

function requestContext(orgId: string, accountId: string): OrgContext {
  return { orgId, actor: { accountId } };
}

function mutationOriginIsValid(
  request: express.Request,
  appUrl: string,
): boolean {
  const bearer =
    /^Bearer [A-Za-z0-9_-]{43}$/.test(request.get('Authorization') ?? '') &&
    !request.headers.cookie;
  return (
    request.get('X-Athlentry-Request') === '1' &&
    (request.get('Origin') === new URL(appUrl).origin ||
      (bearer && request.get('Origin') === undefined))
  );
}

function sendError(response: express.Response, error: unknown): void {
  const status =
    error instanceof z.ZodError || error instanceof RangeError
      ? 400
      : error instanceof WebsiteError
        ? error.status
        : 500;
  const code =
    error instanceof WebsiteError
      ? error.code
      : status === 400
        ? 'VALIDATION_ERROR'
        : status === 401
          ? 'UNAUTHENTICATED'
          : status === 403
            ? 'FORBIDDEN'
            : status === 404
              ? 'NOT_FOUND'
              : status === 409
                ? 'CONFLICT'
                : 'INTERNAL_ERROR';
  response.status(status).json(
    apiErrorSchema.parse({
      error: {
        code,
        message:
          status >= 500
            ? 'The request could not be completed'
            : error instanceof Error
              ? error.message
              : 'Request failed',
      },
    }),
  );
}

function route(
  handler: (
    request: express.Request,
    response: express.Response,
  ) => Promise<void>,
) {
  return (request: express.Request, response: express.Response) => {
    void handler(request, response).catch((error: unknown) => {
      sendError(response, error);
    });
  };
}

export function createWebsiteRouter(
  dependencies: AuthDependencies,
): express.Router {
  const router = express.Router();
  router.use(express.json({ limit: '128kb' }));
  const withOrg = createWithOrg(dependencies.database);

  router.get(
    '/public/plans',
    route(async (_request, response) => {
      const result = await listPublicWebsitePlans(dependencies.database);
      response.setHeader('Cache-Control', 'public, max-age=300');
      response.json(publicPlansSchema.parse(result));
    }),
  );

  router.get(
    '/public/:orgSlug/news',
    route(async (request, response) => {
      const orgSlug = orgSlugSchema.parse(request.params.orgSlug);
      const result = await listPublicWebsiteNews(
        dependencies.database,
        orgSlug,
        withOrg,
      );
      if (!result) {
        response.sendStatus(404);
        return;
      }
      response
        .setHeader(
          'Cache-Control',
          'public, max-age=60, stale-while-revalidate=300',
        )
        .json(result);
    }),
  );

  router.post(
    '/public/:orgSlug/contact',
    express.urlencoded({ extended: false, limit: '8kb' }),
    route(async (request, response) => {
      const orgSlug = orgSlugSchema.parse(request.params.orgSlug);
      const incoming =
        request.body && typeof request.body === 'object'
          ? (request.body as Record<string, unknown>)
          : {};
      const body = websiteContactSubmissionBodySchema.parse({
        name: incoming.name,
        email: incoming.email,
        subject: incoming.subject,
        body: incoming.body,
        captchaToken:
          incoming.captchaToken ?? incoming['cf-turnstile-response'],
      });
      if (!(await dependencies.captcha.verify(body.captchaToken, request.ip)))
        throw new WebsiteError(403, 'FORBIDDEN', 'Captcha verification failed');
      const submitted = await createPublicWebsiteContactSubmission(
        dependencies.database,
        orgSlug,
        body,
        createHash('sha256').update(body.captchaToken).digest('hex'),
        request.ip,
        dependencies.clock(),
        withOrg,
      );
      if (!submitted) {
        response.sendStatus(404);
        return;
      }
      try {
        await dependencies.email.send({
          to: submitted.inboxEmail,
          subject: 'Website contact form submission',
          text: [
            `Organization: ${submitted.organizationName}`,
            `Name: ${body.name}`,
            `Email: ${body.email}`,
            ...(body.subject ? [`Subject: ${body.subject}`] : []),
            '',
            body.body,
          ].join('\n'),
          replyTo: body.email,
          kind: 'transactional',
          idempotencyKey: `website-contact:${submitted.id}`,
        });
      } catch {
        // The submission remains available in the authenticated website inbox.
      }
      if (request.is('application/x-www-form-urlencoded')) {
        response.redirect(303, `/site/${orgSlug}/contact?sent=1`);
        return;
      }
      response
        .status(202)
        .setHeader('Cache-Control', 'no-store')
        .json(websiteContactSubmissionResponseSchema.parse({ received: true }));
    }),
  );

  router.get(
    '/public/:orgSlug/pages/:pageSlug',
    route(async (request, response) => {
      const orgSlug = orgSlugSchema.parse(request.params.orgSlug);
      const pageSlug = websitePageSlugSchema.parse(request.params.pageSlug);
      const result = await getPublicWebsitePage(
        dependencies.database,
        orgSlug,
        pageSlug,
        withOrg,
      );
      if (!result) {
        response.sendStatus(404);
        return;
      }
      response.setHeader(
        'Cache-Control',
        'public, max-age=60, stale-while-revalidate=300',
      );
      response.json(websitePublicPageSchema.parse(result));
    }),
  );

  router.get(
    '/public/:orgSlug/facilities',
    route(async (request, response) => {
      const orgSlug = orgSlugSchema.parse(request.params.orgSlug);
      const result = await getPublicWebsiteFacilities(
        dependencies.database,
        orgSlug,
        withOrg,
      );
      if (!result) {
        response.sendStatus(404);
        return;
      }
      response
        .setHeader(
          'Cache-Control',
          'public, max-age=60, stale-while-revalidate=300',
        )
        .json(websitePublicFacilitiesSchema.parse(result));
    }),
  );

  router.get(
    '/public/:orgSlug/embeds/:publicKey',
    route(async (request, response) => {
      const orgSlug = orgSlugSchema.parse(request.params.orgSlug);
      const publicKey = z
        .string()
        .regex(/^[A-Za-z0-9_-]{43}$/)
        .parse(request.params.publicKey);
      const result = await getPublicWebsiteEmbed(
        dependencies.database,
        orgSlug,
        publicKey,
        withOrg,
        dependencies.clock(),
      );
      if (!result) {
        response.sendStatus(404);
        return;
      }
      response
        .setHeader(
          'Cache-Control',
          'public, max-age=60, stale-while-revalidate=300',
        )
        .json(websitePublicEmbedSchema.parse(result));
    }),
  );

  router.get(
    '/public/:orgSlug/robots.txt',
    route(async (request, response) => {
      const orgSlug = orgSlugSchema.parse(request.params.orgSlug);
      const site = await getPublicWebsiteRobotsPolicy(
        dependencies.database,
        orgSlug,
        withOrg,
      );
      if (!site) {
        response.sendStatus(404);
        return;
      }
      const sitemap =
        site.robotsPolicy === 'noindex'
          ? ''
          : `Sitemap: https://${orgSlug}.athlentry.com/api/v1/website/public/${encodeURIComponent(orgSlug)}/sitemap.xml\n`;
      response
        .setHeader('Cache-Control', 'public, max-age=300')
        .type('text/plain')
        .send(
          `User-agent: *\n${site.robotsPolicy === 'noindex' ? 'Disallow: /\n' : 'Allow: /\n'}${sitemap}`,
        );
    }),
  );

  router.get(
    '/public/:orgSlug/sitemap.xml',
    route(async (request, response) => {
      const orgSlug = orgSlugSchema.parse(request.params.orgSlug);
      const [pages, news, programs, fundraisers, facilities] =
        await Promise.all([
          listPublicWebsitePages(dependencies.database, orgSlug, withOrg),
          listPublicWebsiteNews(dependencies.database, orgSlug, withOrg),
          getPublicWebsitePrograms(dependencies.database, orgSlug, withOrg),
          getPublicWebsiteFundraisers(dependencies.database, orgSlug, withOrg),
          getPublicWebsiteFacilities(dependencies.database, orgSlug, withOrg),
        ]);
      if (!pages || !news || !programs || !fundraisers || !facilities) {
        response.sendStatus(404);
        return;
      }
      const host = `https://${orgSlug}.athlentry.com`;
      const shouldIndex = news.robotsPolicy === 'index';
      const pageEntries = (shouldIndex ? pages : [])
        .map(
          ({ slug, updated_at }) =>
            `<url><loc>${host}/site/${encodeURIComponent(orgSlug)}${slug === 'home' ? '' : `/${slug.split('/').map(encodeURIComponent).join('/')}`}</loc><lastmod>${updated_at.toISOString()}</lastmod></url>`,
        )
        .join('');
      const generatedEntries = shouldIndex
        ? [
            `${host}/site/${encodeURIComponent(orgSlug)}/programs`,
            `${host}/site/${encodeURIComponent(orgSlug)}/schedule`,
            `${host}/site/${encodeURIComponent(orgSlug)}/sponsors`,
            `${host}/site/${encodeURIComponent(orgSlug)}/facilities`,
            `${host}/site/${encodeURIComponent(orgSlug)}/fundraisers`,
            ...programs.programs.map(
              (program) =>
                `${host}/site/${encodeURIComponent(orgSlug)}/programs/${encodeURIComponent(program.slug)}`,
            ),
            ...facilities.facilities.map(
              (facility) =>
                `${host}/site/${encodeURIComponent(orgSlug)}/facilities/${encodeURIComponent(facility.id)}`,
            ),
            ...fundraisers.fundraisers.map(
              (fundraiser) =>
                `${host}/site/${encodeURIComponent(orgSlug)}/fundraisers/${encodeURIComponent(fundraiser.slug)}`,
            ),
          ]
            .map((url) => `<url><loc>${url}</loc></url>`)
            .join('')
        : '';
      const newsEntry =
        shouldIndex && news.posts.length
          ? `<url><loc>${host}/site/${encodeURIComponent(orgSlug)}/news</loc></url>`
          : '';
      response
        .setHeader('Cache-Control', 'public, max-age=300')
        .type('application/xml')
        .send(
          `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pageEntries}${generatedEntries}${newsEntry}</urlset>`,
        );
    }),
  );

  router.get(
    '/orgs/:orgId/news',
    route(async (request, response) => {
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const result = await listWebsiteNews(
        requestContext(orgId, session.accountId),
        withOrg,
      );
      response.setHeader('Cache-Control', 'no-store');
      response.json(websiteNewsListSchema.parse(result));
    }),
  );

  router.get(
    '/orgs/:orgId/contact-submissions',
    route(async (request, response) => {
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const result = await listWebsiteContactSubmissions(
        requestContext(orgId, session.accountId),
        withOrg,
      );
      response.setHeader('Cache-Control', 'no-store');
      response.json(websiteContactSubmissionListSchema.parse(result));
    }),
  );

  router.post(
    '/orgs/:orgId/contact-submissions/mark-read',
    route(async (request, response) => {
      if (!mutationOriginIsValid(request, dependencies.appUrl)) {
        throw new WebsiteError(
          403,
          'FORBIDDEN',
          'Request origin is not allowed',
        );
      }
      emptyBodySchema.parse(request.body);
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const result = await markWebsiteContactSubmissionsRead(
        requestContext(orgId, session.accountId),
        withOrg,
      );
      response
        .setHeader('Cache-Control', 'no-store')
        .json(websiteContactReadResponseSchema.parse(result));
    }),
  );

  router.post(
    '/orgs/:orgId/news',
    route(async (request, response) => {
      if (!mutationOriginIsValid(request, dependencies.appUrl)) {
        throw new WebsiteError(
          403,
          'FORBIDDEN',
          'Request origin is not allowed',
        );
      }
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const result = await saveWebsiteNews(
        requestContext(orgId, session.accountId),
        undefined,
        websiteNewsBodySchema.parse(request.body),
        dependencies.clock(),
        withOrg,
      );
      response
        .status(201)
        .setHeader('Cache-Control', 'no-store')
        .json(websiteNewsSaveResponseSchema.parse(result));
    }),
  );

  router.put(
    '/orgs/:orgId/news/:postId',
    route(async (request, response) => {
      if (!mutationOriginIsValid(request, dependencies.appUrl)) {
        throw new WebsiteError(
          403,
          'FORBIDDEN',
          'Request origin is not allowed',
        );
      }
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const postId = z.uuid().parse(request.params.postId);
      const result = await saveWebsiteNews(
        requestContext(orgId, session.accountId),
        postId,
        websiteNewsBodySchema.parse(request.body),
        dependencies.clock(),
        withOrg,
      );
      response
        .setHeader('Cache-Control', 'no-store')
        .json(websiteNewsSaveResponseSchema.parse(result));
    }),
  );

  router.get(
    '/orgs/:orgId/settings',
    route(async (request, response) => {
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const result = await getWebsiteSettings(
        requestContext(orgId, session.accountId),
        withOrg,
      );
      response.setHeader('Cache-Control', 'no-store');
      response.json(websiteSettingsResponseSchema.parse(result));
    }),
  );

  router.get(
    '/orgs/:orgId/domains',
    route(async (request, response) => {
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const result = await listWebsiteDomains(
        requestContext(orgId, session.accountId),
        withOrg,
      );
      response.setHeader('Cache-Control', 'no-store');
      response.json(websiteDomainListSchema.parse(result));
    }),
  );

  router.post(
    '/orgs/:orgId/domains',
    route(async (request, response) => {
      if (!mutationOriginIsValid(request, dependencies.appUrl)) {
        throw new WebsiteError(
          403,
          'FORBIDDEN',
          'Request origin is not allowed',
        );
      }
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const host = new URL(dependencies.appUrl).hostname;
      const result = await addWebsiteDomain(
        requestContext(orgId, session.accountId),
        websiteDomainCreateSchema.parse(request.body),
        host,
        withOrg,
      );
      response
        .status(201)
        .setHeader('Cache-Control', 'no-store')
        .json(websiteDomainResponseSchema.parse(result));
    }),
  );

  router.post(
    '/orgs/:orgId/domains/:domainId/verify',
    route(async (request, response) => {
      if (!mutationOriginIsValid(request, dependencies.appUrl)) {
        throw new WebsiteError(
          403,
          'FORBIDDEN',
          'Request origin is not allowed',
        );
      }
      emptyBodySchema.parse(request.body);
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const domainId = domainIdSchema.parse(request.params.domainId);
      const result = await verifyWebsiteDomain(
        requestContext(orgId, session.accountId),
        domainId,
        dependencies.clock(),
        withOrg,
      );
      response
        .setHeader('Cache-Control', 'no-store')
        .json(websiteDomainResponseSchema.parse(result));
    }),
  );

  router.post(
    '/orgs/:orgId/domains/:domainId/primary',
    route(async (request, response) => {
      if (!mutationOriginIsValid(request, dependencies.appUrl)) {
        throw new WebsiteError(
          403,
          'FORBIDDEN',
          'Request origin is not allowed',
        );
      }
      emptyBodySchema.parse(request.body);
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const domainId = domainIdSchema.parse(request.params.domainId);
      const result = await setPrimaryWebsiteDomain(
        requestContext(orgId, session.accountId),
        domainId,
        withOrg,
      );
      response
        .setHeader('Cache-Control', 'no-store')
        .json(websiteDomainResponseSchema.parse(result));
    }),
  );

  router.post(
    '/orgs/:orgId/domains/:domainId/disable',
    route(async (request, response) => {
      if (!mutationOriginIsValid(request, dependencies.appUrl)) {
        throw new WebsiteError(
          403,
          'FORBIDDEN',
          'Request origin is not allowed',
        );
      }
      emptyBodySchema.parse(request.body);
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const domainId = domainIdSchema.parse(request.params.domainId);
      const result = await disableWebsiteDomain(
        requestContext(orgId, session.accountId),
        domainId,
        withOrg,
      );
      response
        .setHeader('Cache-Control', 'no-store')
        .json(websiteDomainResponseSchema.parse(result));
    }),
  );

  router.get(
    '/orgs/:orgId/embeds',
    route(async (request, response) => {
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const result = await listWebsiteEmbeds(
        requestContext(orgId, session.accountId),
        withOrg,
      );
      response.setHeader('Cache-Control', 'no-store');
      response.json(websiteEmbedListSchema.parse(result));
    }),
  );

  router.post(
    '/orgs/:orgId/embeds',
    route(async (request, response) => {
      if (!mutationOriginIsValid(request, dependencies.appUrl)) {
        throw new WebsiteError(
          403,
          'FORBIDDEN',
          'Request origin is not allowed',
        );
      }
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const result = await saveWebsiteEmbed(
        requestContext(orgId, session.accountId),
        undefined,
        websiteEmbedBodySchema.parse(request.body),
        withOrg,
      );
      response
        .status(201)
        .setHeader('Cache-Control', 'no-store')
        .json(websiteEmbedResponseSchema.parse(result));
    }),
  );

  router.put(
    '/orgs/:orgId/embeds/:embedId',
    route(async (request, response) => {
      if (!mutationOriginIsValid(request, dependencies.appUrl)) {
        throw new WebsiteError(
          403,
          'FORBIDDEN',
          'Request origin is not allowed',
        );
      }
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const embedId = z.uuid().parse(request.params.embedId);
      const result = await saveWebsiteEmbed(
        requestContext(orgId, session.accountId),
        embedId,
        websiteEmbedBodySchema.parse(request.body),
        withOrg,
      );
      response
        .setHeader('Cache-Control', 'no-store')
        .json(websiteEmbedResponseSchema.parse(result));
    }),
  );

  router.put(
    '/orgs/:orgId/settings',
    route(async (request, response) => {
      if (!mutationOriginIsValid(request, dependencies.appUrl)) {
        throw new WebsiteError(
          403,
          'FORBIDDEN',
          'Request origin is not allowed',
        );
      }
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const body = websiteSettingsBodySchema.parse(request.body);
      const result = await saveWebsiteSettings(
        requestContext(orgId, session.accountId),
        body,
        withOrg,
      );
      response.setHeader('Cache-Control', 'no-store');
      response.json(websiteSettingsResponseSchema.parse(result));
    }),
  );

  router.get(
    '/orgs/:orgId/menus',
    route(async (request, response) => {
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const result = await listWebsiteMenus(
        requestContext(orgId, session.accountId),
        withOrg,
      );
      response.setHeader('Cache-Control', 'no-store');
      response.json(websiteMenuListSchema.parse(result));
    }),
  );

  router.put(
    '/orgs/:orgId/menus',
    route(async (request, response) => {
      if (!mutationOriginIsValid(request, dependencies.appUrl)) {
        throw new WebsiteError(
          403,
          'FORBIDDEN',
          'Request origin is not allowed',
        );
      }
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const body = websiteMenuBodySchema.parse(request.body);
      const result = await saveWebsiteMenu(
        requestContext(orgId, session.accountId),
        body,
        withOrg,
      );
      response.setHeader('Cache-Control', 'no-store');
      response.json(websiteMenuResponseSchema.parse(result));
    }),
  );

  router.get(
    '/orgs/:orgId/pages',
    route(async (request, response) => {
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const result = await listWebsitePages(
        requestContext(orgId, session.accountId),
        withOrg,
      );
      response.setHeader('Cache-Control', 'no-store');
      response.json(websitePageListSchema.parse(result));
    }),
  );

  router.post(
    '/orgs/:orgId/pages',
    route(async (request, response) => {
      if (!mutationOriginIsValid(request, dependencies.appUrl)) {
        throw new WebsiteError(
          403,
          'FORBIDDEN',
          'Request origin is not allowed',
        );
      }
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const body = websitePageBodySchema.parse(request.body);
      const result = await saveWebsitePage(
        requestContext(orgId, session.accountId),
        undefined,
        body,
        dependencies.clock(),
        withOrg,
      );
      response.status(201).json(websiteSaveResponseSchema.parse(result));
    }),
  );

  router.put(
    '/orgs/:orgId/pages/:pageId',
    route(async (request, response) => {
      if (!mutationOriginIsValid(request, dependencies.appUrl)) {
        throw new WebsiteError(
          403,
          'FORBIDDEN',
          'Request origin is not allowed',
        );
      }
      const session = await requireSession(dependencies, request);
      const orgId = z.uuid().parse(request.params.orgId);
      const pageId = pageIdSchema.parse(request.params.pageId);
      const body = websitePageBodySchema.parse(request.body);
      const result = await saveWebsitePage(
        requestContext(orgId, session.accountId),
        pageId,
        body,
        dependencies.clock(),
        withOrg,
      );
      response.json(websiteSaveResponseSchema.parse(result));
    }),
  );

  return router;
}
