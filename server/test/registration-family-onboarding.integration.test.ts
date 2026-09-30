import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createApp } from '../src/app';
import { createDatabase } from '../src/db/kysely';
import { FakeEmailSender } from '../src/integrations/email/sender';
import { MemoryStorage } from '../src/integrations/storage/storage';
import { parseEncryptionKeys } from '../src/lib/crypto';
import type { AuthDependencies } from '../src/modules/auth/routes';
import { issueSession } from '../src/modules/auth/sessions';

import { createTestFactories } from './factories';

const appUrl = 'http://127.0.0.1:5173';
const now = new Date('2026-09-30T18:00:00.000Z');
const participantsResponseSchema = z.object({
  people: z.array(z.object({ name: z.string() })),
});
const encryption = parseEncryptionKeys(
  JSON.stringify({ test: randomBytes(32).toString('base64') }),
  'test',
);
let database: ReturnType<typeof createDatabase>;
let server: Server;
let baseUrl: string;
let previousDatabaseUrl: string | undefined;

beforeAll(async () => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = process.env.TEST_DATABASE_APP_URL ?? '';
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  const auth = {
    database,
    email: new FakeEmailSender(),
    encryption,
    appUrl,
    clock: () => now,
    localStorage: new MemoryStorage(),
    captchaWidget: { mode: 'preview' as const },
    pushPublicKey: '',
  } as unknown as AuthDependencies;
  server = createApp(auth).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
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
  if (previousDatabaseUrl === undefined)
    Reflect.deleteProperty(process.env, 'DATABASE_URL');
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

describe('new-family registration API wiring', () => {
  it('allows a signed-in unlinked guardian to bootstrap family registration only', async () => {
    const organization = await createTestFactories(database).actor();
    const accountId = randomUUID();
    await database
      .insertInto('accounts')
      .values({
        id: accountId,
        email: `new-family-${accountId}@example.invalid`,
        first_name: 'Rosa',
        last_name: 'Ortega',
        date_of_birth: '1987-03-14',
        email_verified_at: now,
      })
      .execute();
    const session = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        now,
      ),
    );
    const registrationPath = `/api/v1/registration/orgs/${organization.orgId}`;
    const cookie = `__Host-athlentry_session=${session.token}`;
    const readHeaders = { Cookie: cookie };
    const writeHeaders = {
      ...readHeaders,
      Origin: appUrl,
      'X-Athlentry-Request': '1',
      'Content-Type': 'application/json',
    };

    const unauthenticated = await fetch(
      `${baseUrl}${registrationPath}/catalog`,
    );
    expect(unauthenticated.status).toBe(401);
    const unauthenticatedParticipants = await fetch(
      `${baseUrl}${registrationPath}/participants`,
    );
    expect(unauthenticatedParticipants.status).toBe(401);

    const catalog = await fetch(`${baseUrl}${registrationPath}/catalog`, {
      headers: readHeaders,
    });
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({ items: [] });

    const participants = await fetch(
      `${baseUrl}${registrationPath}/participants`,
      { headers: readHeaders },
    );
    expect(participants.status).toBe(200);
    expect(await participants.json()).toEqual({ people: [] });

    const registrations = await fetch(
      `${baseUrl}${registrationPath}/me/registrations`,
      { headers: readHeaders },
    );
    expect(registrations.status).toBe(404);

    const writeWithoutOrigin = await fetch(
      `${baseUrl}${registrationPath}/participants`,
      {
        method: 'POST',
        headers: { ...readHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: 'Mateo',
          lastName: 'Ortega',
          dateOfBirth: '2016-05-10',
        }),
      },
    );
    expect(writeWithoutOrigin.status).toBe(403);

    const created = await fetch(`${baseUrl}${registrationPath}/participants`, {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({
        firstName: 'Mateo',
        lastName: 'Ortega',
        dateOfBirth: '2016-05-10',
      }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      name: 'Mateo Ortega',
      created: true,
    });

    const participantsAfter = await fetch(
      `${baseUrl}${registrationPath}/participants`,
      { headers: readHeaders },
    );
    expect(participantsAfter.status).toBe(200);
    const participantsAfterBody: unknown = await participantsAfter.json();
    const participantsAfterPayload = participantsResponseSchema.parse(
      participantsAfterBody,
    );
    expect(
      participantsAfterPayload.people.map((person) => person.name),
    ).toContain('Mateo Ortega');
  });
});
