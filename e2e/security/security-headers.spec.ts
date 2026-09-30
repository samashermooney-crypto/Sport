import { expect, test } from '@playwright/test';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('SEC-001 / Track C: application responses include the required security headers', async ({
  request,
}) => {
  await expect
    .poll(
      async () => {
        try {
          return (
            await request.get(
              `http://127.0.0.1:${String(3001 + offset)}/healthz`,
            )
          ).status();
        } catch {
          return 0;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(200);
  const response = await request.get(
    `http://127.0.0.1:${String(3001 + offset)}/healthz`,
  );
  const headers = response.headers();
  expect(response.status()).toBe(200);
  expect(headers['content-security-policy']).toContain("default-src 'self'");
  expect(headers['content-security-policy']).toContain(
    "frame-ancestors 'none'",
  );
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['permissions-policy']).toBe(
    'camera=(), microphone=(), geolocation=()',
  );
  expect(headers['x-powered-by']).toBeUndefined();
});
