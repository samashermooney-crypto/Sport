import { apiErrorSchema } from '@shared/schemas/errors';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T extends z.ZodType>(
  path: string,
  schema: T,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  body?: unknown,
  idempotencyKey?: string,
): Promise<z.output<T>> {
  let response: Response;
  try {
    const impersonationId = /(?:^|\/)orgs\/[0-9a-f-]{36}(?:\/|$)/i.test(path)
      ? sessionStorage.getItem('athlentry.impersonation')
      : null;
    response = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'include',
      headers: {
        ...(method === 'GET'
          ? {}
          : {
              'Content-Type': 'application/json',
              'X-Athlentry-Request': '1',
              ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
            }),
        ...(impersonationId
          ? { 'X-Athlentry-Impersonation': impersonationId }
          : {}),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
    });
  } catch {
    throw new ApiError(
      0,
      'NETWORK',
      'Cannot connect. Check your connection and try again.',
    );
  }
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(json);
    if (parsed.success) {
      throw new ApiError(
        response.status,
        parsed.data.error.code,
        parsed.data.error.message,
      );
    }
    throw new ApiError(
      response.status,
      'INTERNAL_ERROR',
      'The request could not be completed.',
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success)
    throw new ApiError(
      0,
      'INVALID_RESPONSE',
      'The response could not be read.',
    );
  return parsed.data;
}

export function apiGet<T extends z.ZodType>(
  path: string,
  schema: T,
): Promise<z.output<T>> {
  return request(path, schema, 'GET');
}

export function apiPost<T extends z.ZodType>(
  path: string,
  body: unknown,
  schema: T,
  idempotencyKey?: string,
): Promise<z.output<T>> {
  return request(path, schema, 'POST', body, idempotencyKey);
}

export function apiDelete<T extends z.ZodType>(
  path: string,
  schema: T,
): Promise<z.output<T>> {
  return request(path, schema, 'DELETE');
}

export function apiPatch<T extends z.ZodType>(
  path: string,
  body: unknown,
  schema: T,
): Promise<z.output<T>> {
  return request(path, schema, 'PATCH', body);
}
