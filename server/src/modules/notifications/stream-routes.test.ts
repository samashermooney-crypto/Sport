import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../app';
import { createDatabase } from '../../db/kysely';
import type { AuthDependencies } from '../auth/routes';

import { notificationChannel } from './stream';

const now = new Date('2026-09-26T18:00:00Z');
const accountId = randomUUID();
const orgId = randomUUID();
const token = randomBytes(32).toString('base64url');
let database: ReturnType<typeof createDatabase>;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let baseUrl: string;
let previousDatabaseUrl: string | undefined;

beforeAll(async () => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_APP_URL;
  const admin = new pg.Client({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.connect();
  try {
    await admin.query(
      'INSERT INTO accounts(id,email,first_name,last_name,date_of_birth) VALUES ($1,$2,$3,$4,$5)',
      [
        accountId,
        `${accountId}@example.invalid`,
        'Stream',
        'Tester',
        '1990-01-01',
      ],
    );
    await admin.query(
      `INSERT INTO sessions(id,token_hash,account_id,kind,client,privileged,idle_expires_at,absolute_expires_at)
       VALUES ($1,$2,$3,'cookie','web',false,$4,$5)`,
      [
        randomUUID(),
        createHash('sha256').update(token).digest(),
        accountId,
        new Date(now.getTime() + 60 * 60 * 1000),
        new Date(now.getTime() + 24 * 60 * 60 * 1000),
      ],
    );
  } finally {
    await admin.end();
  }
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const app = createApp({
    database,
    appUrl: 'http://127.0.0.1:5173',
    clock: () => now,
  } as AuthDependencies);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/v1/stream`;
});

afterAll(async () => {
  server.close();
  await database.destroy();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

describe('notification SSE transport', () => {
  it('rejects unauthenticated requests and filters LISTEN/NOTIFY by account', async () => {
    const anonymous = await fetch(baseUrl);
    expect(anonymous.status).toBe(401);

    const abort = new AbortController();
    const response = await fetch(baseUrl, {
      headers: { Cookie: `__Host-athlentry_session=${token}` },
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('SSE response has no body');
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(': connected');

    const notifier = new pg.Client({
      connectionString: process.env.TEST_DATABASE_APP_URL,
    });
    await notifier.connect();
    try {
      const pending = reader.read();
      await notifier.query('SELECT pg_notify($1, $2)', [
        notificationChannel,
        JSON.stringify({ id: randomUUID(), orgId, accountId: randomUUID() }),
      ]);
      const eventId = randomUUID();
      await notifier.query('SELECT pg_notify($1, $2)', [
        notificationChannel,
        JSON.stringify({ id: eventId, orgId, accountId }),
      ]);
      const event = await pending;
      let body = new TextDecoder().decode(event.value);
      while (!body.includes('\n\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('SSE stream ended mid-event');
        body += new TextDecoder().decode(chunk.value);
      }
      expect(body).toContain(`id: ${eventId}`);
      expect(body).toContain('event: notification');
      expect(body).toContain(`"orgId":"${orgId}"`);
      expect(body).not.toContain(accountId);
    } finally {
      abort.abort();
      await notifier.end();
    }
  });
});
