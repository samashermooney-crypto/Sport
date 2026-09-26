import { mkdir, writeFile } from 'node:fs/promises';

import { z } from 'zod';

import { healthResponseSchema } from '../shared/src/schemas/health';

const document = {
  openapi: '3.1.0',
  info: { title: 'Athlentry API', version: '0.1.0' },
  paths: {
    '/healthz': {
      get: {
        operationId: 'healthz',
        responses: {
          '200': {
            description: 'Process is running',
            content: {
              'application/json': {
                schema: z.toJSONSchema(healthResponseSchema),
              },
            },
          },
        },
      },
    },
  },
};

await mkdir('docs/api', { recursive: true });
await writeFile(
  'docs/api/openapi.json',
  `${JSON.stringify(document, null, 2)}\n`,
);
