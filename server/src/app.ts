import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { modulePermissions } from '@shared/generated/permissions';
import { healthResponseSchema } from '@shared/schemas/health';
import express from 'express';
import { sql } from 'kysely';

import { getDatabase } from './db/kysely';
import { serverModules } from './generated/registry';
import type { StripeWebhookDependencies } from './integrations/stripe/webhook-routes';
import { createStripeWebhookRouter } from './integrations/stripe/webhook-routes';
import { publicStatus, readinessResponse } from './lib/observability/health';
import { writeStructuredLog } from './lib/observability/logging';
import { captureRedactedException } from './lib/observability/sentry';
import { createSecurityHeaders } from './lib/security/security-headers';
import { tenantGuard } from './lib/tenant-guard';
import type { AuthDependencies } from './modules/auth/routes';

export type OperationalHealthDependencies = {
  databaseReady: () => Promise<boolean>;
  workerReady: () => Promise<boolean>;
};

async function databaseReady(): Promise<boolean> {
  try {
    await sql`SELECT 1`.execute(getDatabase());
    return true;
  } catch {
    return false;
  }
}

async function workerReady(): Promise<boolean> {
  try {
    const result = await sql<{ heartbeat_at: Date | null }>`
      SELECT max(heartbeat_at) AS heartbeat_at
      FROM worker_heartbeats WHERE stopped_at IS NULL
    `.execute(getDatabase());
    const heartbeat = result.rows[0]?.heartbeat_at;
    return Boolean(heartbeat && Date.now() - heartbeat.getTime() <= 90_000);
  } catch {
    return false;
  }
}

export function createApp(
  auth?: AuthDependencies,
  stripeWebhooks?: StripeWebhookDependencies,
  health: OperationalHealthDependencies = { databaseReady, workerReady },
): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(
    createSecurityHeaders({
      ...(process.env.ATHLENTRY_STORAGE_PUBLIC_ORIGIN
        ? {
            storagePublicOrigin: process.env.ATHLENTRY_STORAGE_PUBLIC_ORIGIN,
          }
        : {}),
    }),
  );
  const securityContactFile = readFileSync(
    resolve('docs/security/security.txt'),
    'utf8',
  );
  app.get('/.well-known/security.txt', (_request, response) => {
    if (process.env.NODE_ENV === 'production') {
      const contact = process.env.ATHLENTRY_SECURITY_CONTACT;
      const policy = process.env.ATHLENTRY_SECURITY_POLICY_URL;
      if (
        !contact?.startsWith('mailto:') ||
        !policy?.startsWith('https://') ||
        contact.includes('.example') ||
        policy.includes('.example')
      ) {
        response
          .status(503)
          .type('text/plain')
          .send('Security contact is not configured.');
        return;
      }
      response
        .type('text/plain')
        .send(
          securityContactFile
            .replace(/^Contact:.*$/m, `Contact: ${contact}`)
            .replace(/^Policy:.*$/m, `Policy: ${policy}`),
        );
      return;
    }
    response.type('text/plain').send(securityContactFile);
  });
  const knownPermissions = new Set<string>(modulePermissions);
  for (const module of serverModules) {
    for (const permission of module.permissions ?? []) {
      if (!knownPermissions.has(permission)) {
        throw new Error(`Unknown module permission: ${permission}`);
      }
    }
  }
  app.get('/healthz', (_request, response) => {
    response.json(healthResponseSchema.parse({ status: 'ok' }));
  });
  app.get('/readyz', async (_request, response) => {
    const ready = await health.databaseReady().catch(() => false);
    response.status(ready ? 200 : 503).json(readinessResponse(ready));
  });
  app.get('/status', async (_request, response) => {
    const [database, worker] = await Promise.all([
      health.databaseReady().catch(() => false),
      health.workerReady().catch(() => false),
    ]);
    const status = publicStatus({ api: true, database, worker });
    response.status(status.status === 'operational' ? 200 : 503).json(status);
  });
  // Stripe signatures cover the original bytes, so this ingress route must stay
  // ahead of tenant and feature routers that may parse request bodies.
  if (stripeWebhooks) {
    app.use('/api/v1/webhooks', createStripeWebhookRouter(stripeWebhooks));
  }
  if (auth) {
    app.use('/api/v1', tenantGuard(auth));
    for (const module of serverModules) {
      if (module.router) app.use(module.path, module.router(auth));
      for (const extra of module.extraRouters ?? []) {
        app.use(extra.path, extra.router(auth));
      }
    }
  }
  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      next: express.NextFunction,
    ) => {
      if (response.headersSent) {
        next(error);
        return;
      }
      captureRedactedException(error);
      writeStructuredLog('error', 'http.request.failed', {
        statusCode: 500,
        result: 'failed',
      });
      response.status(500).json({ error: 'INTERNAL_ERROR' });
    },
  );
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static('dist/web'));
    app.use((request, response, next) => {
      if (request.method === 'GET' && request.accepts('html')) {
        response.sendFile(resolve('dist/web/index.html'));
      } else {
        next();
      }
    });
  }
  return app;
}
