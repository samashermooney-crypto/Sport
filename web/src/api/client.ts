import { apiErrorSchema } from '@shared/schemas/errors';
import type { z } from 'zod';

class ApiError extends Error {
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
  method: 'GET' | 'POST' | 'DELETE',
  body?: unknown,
): Promise<z.output<T>> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      credentials: 'include',
      ...(method === 'GET'
        ? {}
        : {
            headers: {
              'Content-Type': 'application/json',
              'X-Athlentry-Request': '1',
            },
          }),
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
): Promise<z.output<T>> {
  return request(path, schema, 'POST', body);
}
