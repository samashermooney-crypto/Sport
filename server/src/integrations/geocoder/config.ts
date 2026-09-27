import { z } from 'zod';

import type { IntegrationConfig } from '../../lib/module-contract';

export const geocoderConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('none') }),
  z.strictObject({
    mode: z.literal('nominatim'),
    userAgent: z.string().min(8).max(200),
    baseUrl: z.url().default('https://nominatim.openstreetmap.org'),
    allowedHosts: z
      .array(z.string().min(1))
      .min(1)
      .default(['nominatim.openstreetmap.org']),
  }),
]);
export type GeocoderConfig = z.infer<typeof geocoderConfigSchema>;
export const integrationConfig = {
  name: 'geocoder',
  schema: geocoderConfigSchema,
} satisfies IntegrationConfig;
