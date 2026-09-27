import { z } from 'zod';

export const pushConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('fake') }),
  z.strictObject({ mode: z.literal('preview') }),
  z.strictObject({
    mode: z.literal('web-push'),
    subject: z
      .string()
      .refine((value) => value.startsWith('mailto:') || URL.canParse(value)),
    publicKey: z.string().min(1),
    privateKey: z.string().min(1),
  }),
]);
export type PushConfig = z.infer<typeof pushConfigSchema>;
