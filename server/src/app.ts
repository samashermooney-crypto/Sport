import { resolve } from 'node:path';

import { modulePermissions } from '@shared/generated/permissions';
import { healthResponseSchema } from '@shared/schemas/health';
import express from 'express';

import { serverModules } from './generated/registry';
import { tenantGuard } from './lib/tenant-guard';
import type { AuthDependencies } from './modules/auth/routes';

export function createApp(auth?: AuthDependencies): express.Express {
  const app = express();
  app.disable('x-powered-by');
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
  if (auth) {
    app.use('/api/v1', tenantGuard(auth));
    for (const module of serverModules) {
      if (module.router) app.use(module.path, module.router(auth));
      for (const extra of module.extraRouters ?? []) {
        app.use(extra.path, extra.router(auth));
      }
    }
  }
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
