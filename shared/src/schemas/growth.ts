import { z } from 'zod';

const onboardingItemSchema = z.strictObject({
  key: z.enum([
    'connect_payments',
    'users_roles',
    'choose_sports',
    'create_program',
    'add_facilities',
    'configure_compliance',
    'import_members',
    'publish_website',
    'open_registration',
  ]),
  label: z.string(),
  href: z.string(),
  description: z.string(),
  state: z.enum(['pending', 'complete', 'dismissed']),
  completedAt: z.string().nullable(),
  dismissedAt: z.string().nullable(),
});

export const onboardingChecklistSchema = z.strictObject({
  items: z.array(onboardingItemSchema),
  completeCount: z.number(),
});

const helpArticleSummarySchema = z.strictObject({
  slug: z.string(),
  locale: z.string(),
  title: z.string(),
  summary: z.string(),
  category: z.string(),
  audience: z.enum(['admin', 'family', 'all']),
  order: z.number(),
});

export const helpArticleSchema = helpArticleSummarySchema.extend({
  body: z.string(),
});

export const helpCatalogSchema = z.strictObject({
  articles: z.array(helpArticleSummarySchema),
  categories: z.array(z.string()),
});

export const helpSearchResultsSchema = z.strictObject({
  results: z.array(helpArticleSummarySchema),
});

export const supportRequestResponseSchema = z.strictObject({
  id: z.uuid(),
});

export const supportRequestBodySchema = z.strictObject({
  kind: z.enum(['support', 'concierge_import']).default('support'),
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10_000),
  contactEmail: z.email().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

export const aiStatusSchema = z.strictObject({
  enabled: z.boolean(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  orgId: z.uuid(),
});

export const aiFormDraftQuerySchema = z.strictObject({
  name: z.string().min(1).max(200).optional(),
});

export const aiTranslateBodySchema = z.strictObject({
  text: z.string().min(1).max(20_000),
  target: z.enum(['en', 'es']),
});

export const aiChatBodySchema = z.strictObject({
  message: z.string().min(1).max(4000),
  conversationId: z.uuid().optional(),
  visitorKey: z.string().max(200).optional(),
});

export const aiDraftResponseSchema = z.strictObject({
  draftId: z.uuid(),
  draft: z.unknown(),
  redactions: z.number(),
});

export const aiApplyResponseSchema = z.strictObject({
  formDefinitionId: z.uuid(),
});

export const aiTranslateResponseSchema = z.strictObject({
  text: z.string(),
  redactions: z.number(),
});

export const aiChatResponseSchema = z.strictObject({
  conversationId: z.uuid(),
  answer: z.string(),
  refused: z.boolean(),
  citations: z.array(z.strictObject({ title: z.string(), ref: z.string() })),
});

export const aiConversationListSchema = z.strictObject({
  conversations: z.array(
    z.strictObject({
      id: z.uuid(),
      createdAt: z.string(),
      expiresAt: z.string(),
      messages: z.number().int().nonnegative(),
    }),
  ),
});
