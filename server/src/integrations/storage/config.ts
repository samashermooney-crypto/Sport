import { z } from 'zod';

export const storageConfigSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('memory') }),
  z.strictObject({ mode: z.literal('local'), directory: z.string().min(1) }),
  z.strictObject({
    mode: z.literal('s3'),
    endpoint: z.url(),
    bucket: z.string().min(1),
    region: z.string().min(1),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
  }),
]);
export type StorageConfig = z.infer<typeof storageConfigSchema>;
