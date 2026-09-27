import { z } from 'zod';

export const refundTermsSchema = z.strictObject({
  policy: z.strictObject({
    rules: z.array(
      z.strictObject({
        throughDate: z.iso.date(),
        refundBps: z.number().int().min(0).max(10_000),
      }),
    ),
    afterLastBps: z.number().int().min(0).max(10_000),
    serviceFeeRefund: z.enum(['proportional', 'none']),
  }),
  approvalThresholdCents: z.number().int().nonnegative(),
  refundApplicationFee: z.boolean(),
});

export type RefundTerms = z.infer<typeof refundTermsSchema>;
