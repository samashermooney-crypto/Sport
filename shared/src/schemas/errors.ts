import { z } from 'zod';

import { moduleErrorCodes } from '../generated/errors';

const coreErrorCodes = [
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
] as const;

export const errorCodeSchema = z.enum([...coreErrorCodes, ...moduleErrorCodes]);

export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});

export type ErrorCode = z.infer<typeof errorCodeSchema>;
