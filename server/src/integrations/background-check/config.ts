import { z } from 'zod';

import type { IntegrationConfig } from '../../lib/module-contract';

export const backgroundCheckConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('manual') }),
  z.strictObject({
    mode: z.literal('checkr'),
    apiKey: z.string().min(1),
    baseUrl: z
      .enum(['https://api.checkr.com', 'https://api.checkr-staging.com'])
      .default('https://api.checkr.com'),
  }),
]);
export type BackgroundCheckConfig = z.infer<typeof backgroundCheckConfigSchema>;
export const integrationConfig = {
  name: 'background-check',
  schema: backgroundCheckConfigSchema,
} satisfies IntegrationConfig;
