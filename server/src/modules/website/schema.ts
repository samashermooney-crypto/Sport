import { z } from 'zod';

export const publicPlansSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      key: z.string(),
      name: z.string(),
      monthlyPriceCents: z.number().int().nonnegative(),
      customPricing: z.boolean(),
    }),
  ),
});
