import type { z } from 'zod';

import { ApiError } from '../../api/client';

export function orgHeaders(orgId: string): Record<string, string> {
  return { 'X-Athlentry-Org': orgId };
}

export async function apiGetOrg<T extends z.ZodType>(
  path: string,
  schema: T,
  orgId: string,
): Promise<z.output<T>> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      credentials: 'include',
      headers: orgHeaders(orgId),
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
    const error =
      typeof json === 'object' && json !== null && 'error' in json
        ? (json as { error?: unknown }).error
        : null;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : 'INTERNAL_ERROR';
    const message =
      typeof error === 'object' && error !== null && 'message' in error
        ? String(error.message)
        : typeof json === 'object' && json !== null && 'message' in json
          ? String(json.message)
          : 'The request could not be completed.';
    throw new ApiError(response.status, code, message);
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
