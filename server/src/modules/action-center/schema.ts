import { z } from 'zod';

export const actionCenterItemSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  detail: z.string().min(1),
  href: z.string().startsWith('/'),
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
  actionLabel: z.string().min(1),
  href: z.string().startsWith('/'),
  items: z.array(actionCenterItemSchema).max(5),
});

export const actionCenterResponseSchema = z.strictObject({
  cards: z.array(actionCenterCardSchema),
});

export type ActionCenterCard = z.infer<typeof actionCenterCardSchema>;
export type ActionCenterItem = z.infer<typeof actionCenterItemSchema>;
