import { apiErrorSchema } from '@shared/schemas/errors';
import { orgSlugSchema } from '@shared/schemas/orgs';
import {
  websiteMenuBodySchema,
  websiteMenuListSchema,
  websiteMenuResponseSchema,
  websitePageBodySchema,
  websitePageListSchema,
  websitePageSlugSchema,
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
  getPublicWebsitePage,
  getWebsiteSettings,
  listPublicWebsitePlans,
  listPublicWebsitePages,
  listWebsiteMenus,
  listWebsitePages,
  saveWebsiteMenu,
  saveWebsitePage,
  saveWebsiteSettings,
} from './service';

const pageIdSchema = z.uuid();

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
    '/public/:orgSlug/sitemap.xml',
    route(async (request, response) => {
      const orgSlug = orgSlugSchema.parse(request.params.orgSlug);
      const pages = await listPublicWebsitePages(
        dependencies.database,
        orgSlug,
        withOrg,
      );
      if (!pages) {
        response.sendStatus(404);
        return;
      }
      const host = `https://${orgSlug}.athlentry.com`;
      const entries = pages
        .map(
          ({ slug, updated_at }) =>
            `<url><loc>${host}/site/${slug.split('/').map(encodeURIComponent).join('/')}</loc><lastmod>${updated_at.toISOString()}</lastmod></url>`,
        )
        .join('');
      response
        .setHeader('Cache-Control', 'public, max-age=300')
        .type('application/xml')
        .send(
          `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>`,
        );
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
