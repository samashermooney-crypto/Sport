import { z } from 'zod';

export const healthResponseSchema = z.strictObject({ status: z.literal('ok') });
