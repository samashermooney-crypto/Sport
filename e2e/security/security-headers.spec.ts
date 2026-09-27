import { expect, test } from '@playwright/test';

test('SEC-001 / Track C: application responses include the required security headers', async ({
  request,
}) => {
  const response = await request.get('/api/v1/auth/legal');
  const headers = response.headers();
  expect(headers['content-security-policy']).toContain("default-src 'self'");
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBeTruthy();
  expect(headers['permissions-policy']).toContain('camera=()');
});
