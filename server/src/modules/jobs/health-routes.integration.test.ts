import { once } from 'node:events';
import type { Server } from 'node:http';

import express from 'express';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';

import { createOperationalHealthRouter } from './health-routes';

let database: Kysely<DB>;
let server: Server;
let baseUrl: string;

const publicStatusSchema = z.strictObject({
  status: z.enum(['operational', 'degraded']),
  components: z.strictObject({
    api: z.enum(['operational', 'degraded']),
    database: z.enum(['operational', 'degraded']),
    worker: z.enum(['operational', 'degraded']),
  }),
});

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const app = express();
  app.use(createOperationalHealthRouter(database));
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Health route test server did not bind to a TCP port');
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  await database.destroy();
});

describe('registered operational health routes', () => {
  it('reports database readiness without exposing dependency details', async () => {
    const response = await fetch(`${baseUrl}/readyz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ready: true });
  });

  it('reports only public component state from the status route', async () => {
    const response = await fetch(`${baseUrl}/status`);
    expect(response.status).toBe(200);
    const body = publicStatusSchema.parse(await response.json());
    expect(body.components.api).toBe('operational');
    expect(body.components.database).toBe('operational');
    expect(JSON.stringify(body)).not.toMatch(
      /postgres|stripe|email|account|queue/i,
    );
  });
});
