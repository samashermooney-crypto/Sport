export async function platformApi<T>(
  path: string,
  options: {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
  } = {},
): Promise<T> {
  const response = await fetch(`/api/v1/platform${path}`, {
    method: options.method ?? 'GET',
    credentials: 'include',
    ...(options.method && options.method !== 'GET'
      ? {
          headers: {
            'Content-Type': 'application/json',
            'X-Athlentry-Request': '1',
          },
        }
      : {}),
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  if (!response.ok) {
    const fallback =
      response.status === 403
        ? 'Platform access is unavailable for this account.'
        : response.status === 409
          ? 'This record changed. Refresh and try again.'
          : 'The request could not be completed.';
    throw new Error(fallback);
  }
  return (await response.json()) as T;
}
