import { describe, expect, it } from 'vitest';

import { CaptchaServiceUnavailableError, TurnstileCaptcha } from './provider';

function verifier(payload: unknown, status = 200): TurnstileCaptcha {
  const fetcher: typeof fetch = (_url, init) => {
    expect(init?.method).toBe('POST');
    const body = init?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect((body as URLSearchParams).get('secret')).toBe('test-secret');
    expect((body as URLSearchParams).get('response')).toBe('test-token');
    expect((body as URLSearchParams).get('remoteip')).toBe('192.0.2.1');
    return Promise.resolve(new Response(JSON.stringify(payload), { status }));
  };
  return new TurnstileCaptcha('test-secret', 'athlentry.example', fetcher);
}

describe('Turnstile server validation', () => {
  it('accepts only a successful response for the expected hostname and action', async () => {
    expect(
      await verifier({
        success: true,
        hostname: 'athlentry.example',
        action: 'sign-up',
      }).verify('test-token', '192.0.2.1'),
    ).toBe(true);
    expect(
      await verifier({
        success: true,
        hostname: 'other.example',
        action: 'sign-up',
      }).verify('test-token', '192.0.2.1'),
    ).toBe(false);
    expect(
      await verifier({
        success: true,
        hostname: 'athlentry.example',
        action: 'other',
      }).verify('test-token', '192.0.2.1'),
    ).toBe(false);
    expect(
      await verifier({ success: false }).verify('test-token', '192.0.2.1'),
    ).toBe(false);
  });

  it('fails closed when Siteverify is unavailable', async () => {
    await expect(
      verifier({ success: false }, 503).verify('test-token', '192.0.2.1'),
    ).rejects.toBeInstanceOf(CaptchaServiceUnavailableError);
  });
});
