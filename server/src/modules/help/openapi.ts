import { z } from 'zod';

const articleSummarySchema = z.object({
  slug: z.string(),
  locale: z.enum(['en', 'es']),
  title: z.string(),
  summary: z.string(),
  category: z.string(),
  audience: z.string(),
});

export const helpOpenApiRoutes = [
  {
    method: 'get',
    path: '/api/v1/help/articles',
    summary: 'List organization help articles',
    tenancyFixture: { tenantHeader: true },
    query: {
      locale: z.enum(['en', 'es']).optional(),
      audience: z.enum(['all', 'staff', 'family']).optional(),
    },
    response: z.object({
      articles: z.array(articleSummarySchema),
      categories: z.array(z.string()),
    }),
  },
  {
    method: 'get',
    path: '/api/v1/help/articles/{slug}',
    summary: 'Read an organization help article',
    tenancyFixture: { tenantHeader: true },
    query: { locale: z.enum(['en', 'es']).optional() },
    response: articleSummarySchema.extend({ body: z.string() }),
  },
  {
    method: 'get',
    path: '/api/v1/help/search',
    summary: 'Search organization help articles',
    tenancyFixture: { tenantHeader: true },
    query: {
      q: z.string().optional(),
      locale: z.enum(['en', 'es']).optional(),
    },
    response: z.object({ results: z.array(articleSummarySchema) }),
  },
  {
    method: 'post',
    path: '/api/v1/help/support-requests',
    summary: 'Send an in-app support or import concierge request',
    tenancyFixture: {
      body: {
        kind: 'support',
        subject: 'Security regression',
        body: 'Foreign organization request',
      },
      tenantHeader: true,
    },
    body: z.object({
      kind: z.enum(['support', 'concierge_import']).default('support'),
      subject: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(10_000),
      contactEmail: z.email().optional(),
      context: z.record(z.string(), z.unknown()).optional(),
    }),
    response: z.object({ id: z.uuid() }),
    status: 201,
  },
] as const;
