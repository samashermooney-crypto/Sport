import { z } from 'zod';

import type { IntegrationConfig } from '../../lib/module-contract';

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
export const integrationConfig = {
  name: 'push',
  schema: pushConfigSchema,
} satisfies IntegrationConfig;
