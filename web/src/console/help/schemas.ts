import { z } from 'zod';

export const onboardingChecklistSchema = z.strictObject({
  items: z.array(
    z.strictObject({
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
    }),
  ),
  completeCount: z.number(),
});

export const helpArticleSummarySchema = z.strictObject({
  slug: z.string(),
  locale: z.string(),
  title: z.string(),
  summary: z.string(),
  category: z.string(),
  audience: z.string(),
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

export const supportRequestResponseSchema = z.strictObject({ id: z.uuid() });

export const aiStatusSchema = z.strictObject({
  enabled: z.boolean(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  orgId: z.string(),
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
