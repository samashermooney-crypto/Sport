import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app';

const environmentKeys = [
  'NODE_ENV',
  'ATHLENTRY_SECURITY_CONTACT',
  'ATHLENTRY_SECURITY_POLICY_URL',
] as const;
const originalEnvironment = new Map(
  environmentKeys.map((key) => [key, process.env[key]]),
);
let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => {
      server?.close(() => {
        resolve();
      });
    });
    server = undefined;
  }
  const nodeEnv = originalEnvironment.get('NODE_ENV');
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  const securityContact = originalEnvironment.get('ATHLENTRY_SECURITY_CONTACT');
  if (securityContact === undefined)
    delete process.env.ATHLENTRY_SECURITY_CONTACT;
  else process.env.ATHLENTRY_SECURITY_CONTACT = securityContact;
  const securityPolicy = originalEnvironment.get(
    'ATHLENTRY_SECURITY_POLICY_URL',
  );
  if (securityPolicy === undefined)
    delete process.env.ATHLENTRY_SECURITY_POLICY_URL;
  else process.env.ATHLENTRY_SECURITY_POLICY_URL = securityPolicy;
});

async function start(): Promise<string> {
  const app = createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server?.once('listening', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(address.port)}/.well-known/security.txt`;
}

describe('security.txt route', () => {
  it('serves the draft contact file outside production', async () => {
    process.env.NODE_ENV = 'test';
    delete process.env.ATHLENTRY_SECURITY_CONTACT;
    delete process.env.ATHLENTRY_SECURITY_POLICY_URL;

    const response = await fetch(await start());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain('Preferred-Languages: en, es');
  });

  it('fails closed in production until a staffed contact and policy URL exist', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ATHLENTRY_SECURITY_CONTACT;
    delete process.env.ATHLENTRY_SECURITY_POLICY_URL;

    const response = await fetch(await start());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('.example');
  });

  it('substitutes deployment-owned contact details in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ATHLENTRY_SECURITY_CONTACT = 'mailto:security@example.test';
    process.env.ATHLENTRY_SECURITY_POLICY_URL =
      'https://example.test/security/vulnerability-disclosure';

    const response = await fetch(await start());
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('Contact: mailto:security@example.test');
    expect(body).toContain(
      'Policy: https://example.test/security/vulnerability-disclosure',
    );
    expect(body).not.toContain('Contact: mailto:security@athlentry.example');
    expect(body).not.toContain(
      'Policy: https://athlentry.example/security/vulnerability-disclosure',
    );
  });
});
