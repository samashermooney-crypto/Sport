import { z } from 'zod';

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
  actionLabel: z.string(),
  href: z.string().startsWith('/'),
  items: z.array(itemSchema).max(5),
});

export const actionCenterResponseSchema = z.strictObject({
  cards: z.array(cardSchema),
});

export type ActionCenterCard = z.infer<typeof cardSchema>;
