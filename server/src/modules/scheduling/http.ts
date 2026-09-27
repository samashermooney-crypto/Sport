import { apiErrorSchema, errorCodeSchema } from '@shared/schemas/errors';
import type { Response, Request } from 'express';
import { z } from 'zod';

import { ScheduleAccessError } from './access';
import { SchedulingRuleError } from './events';

export function mutationOriginIsValid(
  request: Request,
  appUrl: string,
): boolean {
  const bearer =
    /^Bearer [A-Za-z0-9_-]{43}$/.test(request.get('Authorization') ?? '') &&
    !request.headers.cookie;
  return (
    request.get('X-Athlentry-Request') === '1' &&
    (request.get('Origin') === new URL(appUrl).origin ||
      (bearer && request.get('Origin') === undefined))
  );
}

export function sendScheduleError(response: Response, error: unknown): void {
  const status =
    error instanceof ScheduleAccessError || error instanceof SchedulingRuleError
      ? error.status
      : error instanceof z.ZodError || error instanceof RangeError
        ? 400
        : error instanceof Error &&
            'status' in error &&
            typeof error.status === 'number'
          ? error.status
          : error instanceof Error && 'code' in error && error.code === '23P01'
            ? 409
            : 500;
  const candidateCode =
    error instanceof SchedulingRuleError
      ? error.code
      : error instanceof ScheduleAccessError
        ? status === 404
          ? 'NOT_FOUND'
          : 'FORBIDDEN'
        : error instanceof z.ZodError || error instanceof RangeError
          ? 'VALIDATION_ERROR'
          : error instanceof Error && 'code' in error && error.code === '23P01'
            ? 'SCHEDULE_CONFLICT'
            : error instanceof Error &&
                'code' in error &&
                typeof error.code === 'string'
              ? error.code
              : status === 401
                ? 'UNAUTHENTICATED'
                : status === 404
                  ? 'NOT_FOUND'
                  : status === 409
                    ? 'CONFLICT'
                    : 'INTERNAL_ERROR';
  const code = errorCodeSchema.safeParse(candidateCode).success
    ? candidateCode
    : 'INTERNAL_ERROR';
  const message =
    status >= 500
      ? 'The request could not be completed.'
      : error instanceof Error
        ? error.message
        : 'Request failed.';
  const details =
    error instanceof SchedulingRuleError && error.details !== undefined
      ? { details: JSON.stringify(error.details) }
      : undefined;
  response.status(status).json(
    apiErrorSchema.parse({
      error: { code, message, ...(details ? { fields: details } : {}) },
    }),
  );
}

export function routeError(response: Response, error: unknown): void {
  sendScheduleError(response, error);
}
