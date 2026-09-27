import { z } from 'zod';

import type { IntegrationConfig } from '../../lib/module-contract';

export const emailConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('fake') }),
  z.strictObject({
    mode: z.literal('preview'),
    host: z.string().default('127.0.0.1'),
    port: z.coerce.number().int().min(1).max(65535).default(1025),
  }),
  z.strictObject({
    mode: z.literal('resend'),
    apiKey: z.string().min(1),
    from: z.string().min(3),
    campaignFrom: z.string().min(3).optional(),
  }),
]);
export type EmailConfig = z.infer<typeof emailConfigSchema>;
export const integrationConfig = {
  name: 'email',
  schema: emailConfigSchema,
} satisfies IntegrationConfig;
