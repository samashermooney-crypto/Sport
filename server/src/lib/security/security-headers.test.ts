import type { AddressInfo } from 'node:net';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { createSecurityHeaders } from './security-headers';

const servers: ReturnType<ReturnType<typeof express>['listen']>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function start(
  options: Parameters<typeof createSecurityHeaders>[0],
): Promise<string> {
  const app = express();
  app.use(createSecurityHeaders(options));
  app.get('/embed/widget', (_request, response) => response.send('widget'));
  app.get('/private', (_request, response) => response.send('private'));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}`;
}

describe('security response headers middleware', () => {
  it('sets CSP, framing, referrer, permissions and MIME protections', async () => {
    const base = await start({
      production: true,
      storagePublicOrigin: 'https://assets.athlentry.test',
    });
    const response = await fetch(`${base}/private`);
    expect(response.headers.get('content-security-policy')).toContain(
      "default-src 'self'",
    );
    expect(response.headers.get('content-security-policy')).toContain(
      'https://assets.athlentry.test',
    );
    expect(response.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe(
      'strict-origin-when-cross-origin',
    );
    expect(response.headers.get('permissions-policy')).toBe(
      'camera=(), microphone=(), geolocation=()',
    );
  });

  it('allows framing only on the explicit embed route', async () => {
    const base = await start({ production: false });
    const response = await fetch(`${base}/embed/widget`);
    expect(response.headers.get('content-security-policy')).toContain(
      'frame-ancestors *',
    );
    expect(response.headers.get('x-frame-options')).toBeNull();
    expect(response.headers.get('strict-transport-security')).toBeNull();
  });

  it('rejects storage URLs that are not origins', () => {
    expect(() =>
      createSecurityHeaders({
        storagePublicOrigin: 'https://storage.invalid/bucket?download=1',
      }),
    ).toThrow('Storage public origin must be an origin only');
    expect(() =>
      createSecurityHeaders({ storagePublicOrigin: 'javascript:alert(1)' }),
    ).toThrow('Storage public origin must be an absolute HTTP(S) URL');
  });
});
