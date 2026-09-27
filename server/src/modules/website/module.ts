import {
  websitePageBodySchema,
  websitePageListSchema,
  websitePublicPageSchema,
  websiteSaveResponseSchema,
} from '@shared/schemas/website';
import { z } from 'zod';

import type { ServerModule } from '../../lib/module-contract';

import { createWebsiteRouter } from './routes';
import { publicPlansSchema } from './schema';

const routes = [
  {
    method: 'get',
    path: '/api/v1/website/public/plans',
    summary: 'List active public organization subscription plans',
    response: publicPlansSchema,
    public: true,
  },
  {
    method: 'get',
    path: '/api/v1/website/public/{orgSlug}/pages/{pageSlug}',
    summary: 'Get a published public organization website page',
    response: websitePublicPageSchema,
    public: true,
  },
  {
    method: 'get',
    path: '/api/v1/website/public/{orgSlug}/sitemap.xml',
    summary: 'Get the public organization website sitemap',
    response: z.string(),
    contentType: 'application/xml',
    public: true,
  },
  {
    method: 'get',
    path: '/api/v1/website/orgs/{orgId}/pages',
    summary: 'List website pages for an organization editor',
    response: websitePageListSchema,
  },
  {
    method: 'post',
    path: '/api/v1/website/orgs/{orgId}/pages',
    summary: 'Create an organization website page',
    body: websitePageBodySchema,
    response: websiteSaveResponseSchema,
    status: 201,
  },
  {
    method: 'put',
    path: '/api/v1/website/orgs/{orgId}/pages/{pageId}',
    summary: 'Update a website page with optimistic version checking',
    body: websitePageBodySchema,
    response: websiteSaveResponseSchema,
  },
] as const;

export const moduleDefinition = {
  name: 'website',
  path: '/api/v1/website',
  router: createWebsiteRouter,
  openapiRoutes: routes,
} satisfies ServerModule & { openapiRoutes: readonly unknown[] };
