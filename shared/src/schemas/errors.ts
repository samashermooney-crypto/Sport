import { z } from 'zod';

export const errorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'UNDER_13',
  'WEAK_PASSWORD',
  'INVALID_CREDENTIALS',
  'VERIFICATION_REQUIRED',
  'INVALID_TOKEN',
  'NOT_FOUND',
  'UNAUTHENTICATED',
  'REAUTH_REQUIRED',
  'FORBIDDEN',
  'CONFLICT',
  'RATE_LIMITED',
  'DEPENDENCY_UNAVAILABLE',
  'INTERNAL_ERROR',
]);

export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});

export type ErrorCode = z.infer<typeof errorCodeSchema>;
