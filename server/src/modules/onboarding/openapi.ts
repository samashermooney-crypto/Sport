import { z } from 'zod';

const checklistItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  href: z.string(),
  description: z.string(),
  state: z.enum(['pending', 'complete', 'dismissed']),
  completedAt: z.iso.datetime().nullable(),
  dismissedAt: z.iso.datetime().nullable(),
});

export const onboardingOpenApiRoutes = [
  {
    method: 'get',
    path: '/api/v1/onboarding/checklist',
    summary: 'Read organization onboarding checklist progress',
    response: z.object({
      items: z.array(checklistItemSchema),
      completeCount: z.number().int().nonnegative(),
    }),
  },
  {
    method: 'post',
    path: '/api/v1/onboarding/checklist/{key}/dismiss',
    summary: 'Dismiss an onboarding checklist item',
    response: z.object({}),
    status: 204,
  },
  {
    method: 'post',
    path: '/api/v1/onboarding/checklist/{key}/restore',
    summary: 'Restore a dismissed onboarding checklist item',
    response: z.object({}),
    status: 204,
  },
  {
    method: 'post',
    path: '/api/v1/onboarding/checklist/dismiss-all',
    summary: 'Dismiss all remaining onboarding items',
    response: z.object({}),
    status: 204,
  },
] as const;
