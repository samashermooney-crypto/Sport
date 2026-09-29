import { z } from 'zod';

export const actionCenterItemSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  detail: z.string().min(1),
  href: z.string().startsWith('/'),
});

const actionCenterBulkActionSchema = z.enum([
  'mark_contacts_read',
  'past_due_reminders',
  'failed_installment_contacts',
  'staff_compliance_reminders',
]);

export const actionCenterMutationSchema = z.enum([
  'past_due_reminders',
  'failed_installment_contacts',
  'staff_compliance_reminders',
]);

export const actionCenterMutationResponseSchema = z.strictObject({
  sentCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
});

export const actionCenterCardSchema = z.strictObject({
  id: z.enum([
    'registrations',
    'waitlist-offers',
    'team-offers',
    'past-due-balances',
    'failed-installments',
    'disputes',
    'staff-compliance',
    'expiring-credentials',
    'teams',
    'unassigned-players',
    'missing-officials',
    'missing-results',
    'schedule-conflicts',
    'closed-space-events',
    'reschedules',
    'incidents',
    'return-to-play',
    'volunteer-shifts',
    'volunteer-households',
    'unread-contacts',
    'import-errors',
    'failed-messages',
    'stripe-requirements',
  ]),
  title: z.string().min(1),
  count: z.number().int().positive(),
  amountCents: z.number().int().nonnegative().optional(),
  bulkAction: actionCenterBulkActionSchema.optional(),
  actionLabel: z.string().min(1),
  href: z.string().startsWith('/'),
  items: z.array(actionCenterItemSchema).max(5),
});

export const actionCenterResponseSchema = z.strictObject({
  cards: z.array(actionCenterCardSchema),
});

export type ActionCenterCard = z.infer<typeof actionCenterCardSchema>;
export type ActionCenterItem = z.infer<typeof actionCenterItemSchema>;
export type ActionCenterMutation = z.infer<typeof actionCenterMutationSchema>;
