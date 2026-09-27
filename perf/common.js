import http from 'k6/http';

export function required(name) {
  const value = __ENV[name];
  if (!value) throw new Error(`Missing required k6 setting: ${name}`);
  return value;
}

export function readJsonFile(name) {
  const path = required(name);
  try {
    return JSON.parse(open(path));
  } catch {
    throw new Error(`Could not read JSON input file for ${name}`);
  }
}

export function assertPreviewTarget(...requiredSettings) {
  required('BASE_URL');
  if (__ENV.K6_TARGET_ENV !== 'isolated-preview')
    throw new Error('K6_TARGET_ENV must be isolated-preview');
  if (__ENV.NODE_ENV === 'production')
    throw new Error('Load scripts cannot target a production NODE_ENV');
  if (__ENV.DELIVERY_MODE !== 'preview')
    throw new Error('Load scripts require preview delivery');
  if (__ENV.STRIPE_SECRET_KEY?.startsWith('sk_live_'))
    throw new Error('Live Stripe keys are forbidden for load tests');
  requiredSettings.forEach(required);
}

export function apiUrl(path) {
  if (typeof path !== 'string' || !path.startsWith('/'))
    throw new Error('API fixture paths must begin with /');
  return `${required('BASE_URL').replace(/\/$/, '')}${path}`;
}

export function authParams(token, idempotencyKey, surface) {
  if (typeof token !== 'string' || token.length < 20)
    throw new Error('Fixture bearer token is missing or invalid');
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        idempotencyKey,
      ))
  ) {
    throw new Error('Fixture idempotency key must be a UUID');
  }
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Athlentry-Request': '1',
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    tags: {
      kind: 'authenticated',
      ...(surface ? { surface } : {}),
    },
  };
}

export function publicParams() {
  return { tags: { kind: 'public' } };
}

export function requestBody(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function isExpectedStatus(response, allowed) {
  return allowed.includes(response.status);
}

export function readRequest(fixture) {
  return http.get(
    apiUrl(fixture.path),
    authParams(fixture.token, undefined, fixture.surface),
  );
}

export function getPath(value, path) {
  return path.split('.').reduce((current, key) => {
    if (!current || typeof current !== 'object') return undefined;
    return current[key];
  }, value);
}
