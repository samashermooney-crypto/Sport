import { resolve } from 'node:path';

import { healthResponseSchema } from '@shared/schemas/health';
import express from 'express';

import { createAuthRouter } from './modules/auth/routes';
import type { AuthDependencies } from './modules/auth/routes';

export function createApp(auth?: AuthDependencies): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/healthz', (_request, response) => {
    response.json(healthResponseSchema.parse({ status: 'ok' }));
  });
  if (auth) app.use('/api/v1/auth', createAuthRouter(auth));
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
