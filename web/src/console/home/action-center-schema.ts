import { z } from 'zod';

export const actionCenterMutationSchema = z.enum([
  'past_due_reminders',
  'failed_installment_contacts',
  'staff_compliance_reminders',
]);
export type ActionCenterMutation = z.infer<typeof actionCenterMutationSchema>;

const itemSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  detail: z.string(),
  href: z.string().startsWith('/'),
});

const cardSchema = z.strictObject({
  id: z.string(),
  title: z.string(),
  count: z.number().int().positive(),
  amountCents: z.number().int().nonnegative().optional(),
  bulkAction: z
    .enum([
      'mark_contacts_read',
      'past_due_reminders',
      'failed_installment_contacts',
      'staff_compliance_reminders',
    ])
    .optional(),
  actionLabel: z.string(),
  href: z.string().startsWith('/'),
  items: z.array(itemSchema).max(5),
});

export const actionCenterResponseSchema = z.strictObject({
  cards: z.array(cardSchema),
});

export const actionCenterMutationResponseSchema = z.strictObject({
  sentCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
});
