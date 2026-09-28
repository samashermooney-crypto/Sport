import { once } from 'node:events';
import { readdir } from 'node:fs/promises';
import type { Server } from 'node:http';

import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from './app';
import type { StripeEventRepository } from './integrations/stripe/dispatch';

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

describe('Phase 0 server', () => {
  it('reports database readiness and worker status without exposing metrics', async () => {
    const app = createApp(undefined, undefined, {
      databaseReady: () => Promise.resolve(false),
      workerReady: () => Promise.resolve(true),
    });
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Server did not bind a TCP port');
      const base = `http://127.0.0.1:${String(address.port)}`;
      const ready = await fetch(`${base}/readyz`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ ready: false });
      const status = await fetch(`${base}/status`);
      expect(status.status).toBe(503);
      expect(await status.json()).toEqual({
        status: 'degraded',
        components: {
          api: 'operational',
          database: 'degraded',
          worker: 'operational',
        },
      });
    } finally {
      await closeServer(server);
    }
  });

  it('responds to health checks', async () => {
    const server = createApp().listen(0);
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Server did not bind a TCP port');
      const response = await fetch(
        `http://127.0.0.1:${String(address.port)}/healthz`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok' });
    } finally {
      await closeServer(server);
    }
  });

  it('mounts security headers before routes and serves the draft security contact', async () => {
    const server = createApp().listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Server did not bind a TCP port');
      const base = `http://127.0.0.1:${String(address.port)}`;
      const health = await fetch(`${base}/healthz`);
      expect(health.headers.get('content-security-policy')).toContain(
        "default-src 'self'",
      );
      expect(health.headers.get('x-frame-options')).toBe('DENY');
      expect(health.headers.get('strict-transport-security')).toBeNull();

      const security = await fetch(`${base}/.well-known/security.txt`);
      expect(security.status).toBe(200);
      expect(security.headers.get('content-type')).toContain('text/plain');
      expect(await security.text()).toContain(
        'Contact: mailto:security@athlentry.example',
      );
    } finally {
      await closeServer(server);
    }
  });

  it('mounts Stripe ingress with its raw body before the API routers', async () => {
    const event = {
      id: 'evt_app_wiring',
      object: 'event' as const,
      type: 'payment_intent.succeeded',
      livemode: false,
      created: 1_790_000_000,
      data: { object: { id: 'pi_app_wiring', object: 'payment_intent' } },
    };
    const gateway = {
      verifyWebhook: vi.fn(() => event),
    };
    const store = vi.fn(() => Promise.resolve('inserted' as const));
    const enqueue = vi.fn(() => Promise.resolve());
    const repository: StripeEventRepository = {
      store,
      claim: () => Promise.resolve(null),
      complete: () => Promise.resolve(),
      fail: () => Promise.resolve(),
    };
    const app = createApp(undefined, {
      gateway,
      repository,
      enqueue,
      platformSecret: 'whsec_platform_test',
      connectSecret: 'whsec_connect_test',
    });
    const server = app.listen(0, '127.0.0.1');
    try {
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Server did not bind a TCP port');
      const response = await fetch(
        `http://127.0.0.1:${String(address.port)}/api/v1/webhooks/stripe`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'stripe-signature': 'test-signature',
          },
          body: JSON.stringify(event),
        },
      );
      expect(response.status).toBe(200);
      expect(gateway.verifyWebhook).toHaveBeenCalledWith(
        expect.any(Buffer),
        'test-signature',
        'whsec_platform_test',
      );
      expect(store).toHaveBeenCalledOnce();
      expect(enqueue).toHaveBeenCalledWith('evt_app_wiring');
    } finally {
      await closeServer(server);
    }
  });

  it('uses its own migrated PostgreSQL database', async () => {
    const client = new pg.Client({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    await client.connect();
    try {
      const database = await client.query<{ name: string }>(
        'SELECT current_database() AS name',
      );
      expect(database.rows[0]?.name).toMatch(/^t_[0-9a-f]{32}$/);
      const migrations = (
        await readdir(new URL('../../db/migrations/', import.meta.url))
      ).filter((name) => /^\d{4}_.+\.sql$/.test(name));
      const applied = await client.query<{ name: string }>(
        'SELECT name FROM schema_migrations',
      );
      expect(applied.rows.map((row) => row.name)).toEqual(
        expect.arrayContaining(migrations),
      );
    } finally {
      await client.end();
    }
  });
});
