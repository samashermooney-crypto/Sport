import { expect, test } from '@playwright/test';

import { createDatabase } from '../../server/src/db/kysely';
import { hashPassword } from '../../server/src/modules/auth/password';
import { issueSession } from '../../server/src/modules/auth/sessions';
import { createTestFactories } from '../../server/test/factories';
import { e2eDatabaseUrl } from '../database';

const offset = Number(process.env.PORT_OFFSET ?? '0');

test('SEC-005: step-up reauthentication rotates the session token', async ({
  request,
}) => {
  const database = createDatabase(
    e2eDatabaseUrl('app'),
  );
  const password = 'safe step-up sports password 38';
  const apiOrigin = `http://127.0.0.1:${String(3001 + offset)}`;
  const apiBase = `${apiOrigin}/api/v1/auth`;
  const webOrigin = `https://127.0.0.1:${String(5173 + offset)}`;

  try {
    const actor = await createTestFactories(database).actor();
    await database
      .updateTable('accounts')
      .set({ password_hash: await hashPassword(password) })
      .where('id', '=', actor.accountId)
      .execute();
    const session = await database.transaction().execute((trx) =>
      issueSession(
        trx,
        {
          accountId: actor.accountId,
          kind: 'cookie',
          client: 'web',
          privileged: false,
        },
        new Date(),
      ),
    );
    let apiReady = false;
    for (let attempt = 0; attempt < 50 && !apiReady; attempt += 1) {
      try {
        const health = await request.get(`${apiOrigin}/healthz`, {
          timeout: 500,
        });
        apiReady = health.status() === 200;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    expect(
      apiReady,
      'API server should start before the security request',
    ).toBe(true);
    const cookie = `__Host-athlentry_session=${session.token}`;
    const response = await request.post(`${apiBase}/step-up`, {
      headers: {
        Cookie: cookie,
        Origin: webOrigin,
        'X-Athlentry-Request': '1',
      },
      data: { method: 'password', password },
    });

    expect(response.status()).toBe(200);
    const setCookie = response.headers()['set-cookie'];
    expect(setCookie).toContain('__Host-athlentry_session=');
    const rotatedCookie = setCookie?.split(';')[0];
    expect(rotatedCookie).toBeTruthy();
    expect(rotatedCookie).not.toBe(cookie);
    expect(
      (
        await request.get(`${apiBase}/me`, { headers: { Cookie: cookie } })
      ).status(),
    ).toBe(401);
    expect(
      (
        await request.get(`${apiBase}/me`, {
          headers: { Cookie: rotatedCookie ?? '' },
        })
      ).status(),
    ).toBe(200);
  } finally {
    await database.destroy();
  }
});
