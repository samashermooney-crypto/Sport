import { z } from 'zod';

const citationSchema = z.object({
  slug: z.string(),
  title: z.string(),
});

export const aiOpenApiRoutes = [
  {
    method: 'get',
    path: '/api/v1/ai/status',
    summary: 'Read optional AI assistant availability',
    tenancyFixture: { tenantHeader: true },
    response: z.object({
      enabled: z.boolean(),
      provider: z.string().nullable(),
      model: z.string().nullable(),
      orgId: z.uuid(),
    }),
  },
  {
    method: 'post',
    path: '/api/v1/ai/form-drafts',
    summary: 'Create a reviewed draft from a form document',
    tenancyFixture: { tenantHeader: true },
    query: { name: z.string().optional() },
    response: z.object({
      draftId: z.uuid(),
      draft: z.record(z.string(), z.unknown()),
      redactions: z.number().int().nonnegative(),
    }),
    status: 201,
  },
  {
    method: 'post',
    path: '/api/v1/ai/form-drafts/{id}/apply',
    summary: 'Apply a reviewed form draft',
    tenancyFixture: { tenantHeader: true },
    response: z.object({ formDefinitionId: z.uuid() }),
  },
  {
    method: 'post',
    path: '/api/v1/ai/form-drafts/{id}/discard',
    summary: 'Discard a form draft',
    tenancyFixture: { tenantHeader: true },
    response: z.object({}),
    status: 204,
  },
  {
    method: 'post',
    path: '/api/v1/ai/translate',
    summary: 'Translate staff supplied text',
    tenancyFixture: { tenantHeader: true },
    body: z.object({
      text: z.string().min(1).max(20_000),
      target: z.enum(['en', 'es']),
    }),
    response: z.object({
      text: z.string(),
      redactions: z.number().int().nonnegative(),
    }),
  },
  {
    method: 'post',
    path: '/api/v1/ai/chat',
    summary: 'Ask the organization help assistant',
    public: true,
    tenancyFixture: { tenantHeader: true },
    body: z.object({
      message: z.string().min(1).max(4000),
      conversationId: z.uuid().optional(),
      visitorKey: z.string().max(200).optional(),
    }),
    response: z.object({
      conversationId: z.uuid(),
      answer: z.string(),
      refused: z.boolean(),
      citations: z.array(citationSchema),
    }),
  },
  {
    method: 'get',
    path: '/api/v1/ai/conversations',
    summary: 'List staff assistant conversations',
    permission: 'ai.conversations.read',
    tenancyFixture: { tenantHeader: true },
    response: z.object({
      conversations: z.array(
        z.object({
          id: z.uuid(),
          createdAt: z.iso.datetime(),
          expiresAt: z.iso.datetime(),
          messages: z.number().int().nonnegative(),
        }),
      ),
    }),
  },
] as const;
