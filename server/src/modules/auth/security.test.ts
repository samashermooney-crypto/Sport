import { randomBytes } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import { FakeEmailSender } from '../../integrations/email/sender';
import { parseEncryptionKeys } from '../../lib/crypto';

import { hashPassword } from './password';
import {
  beginMfaEnrollment,
  confirmMfaEnrollment,
  regenerateRecoveryCodes,
  stepUpWithPassword,
  stepUpWithTotp,
} from './security';
import type { SecurityDependencies } from './security';
import { issueSession, resolveSession } from './sessions';
import { decodeBase32, totpCode } from './totp';

const accountId = newId();
const orgId = newId();
const email = new FakeEmailSender();
const encryption = parseEncryptionKeys(
  JSON.stringify({ k1: randomBytes(32).toString('base64') }),
  'k1',
);
let now = new Date('2026-09-26T18:00:00Z');
let database: Kysely<DB>;
let dependencies: SecurityDependencies;

beforeAll(async () => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
  dependencies = { database, encryption, email, clock: () => now };
  await database
    .insertInto('accounts')
    .values({
      id: accountId,
      email: 'security-test@example.invalid',
      first_name: 'Security',
      last_name: 'Test',
      date_of_birth: '2000-01-01',
      password_hash: await hashPassword('large cedar forest bridge 14'),
      email_verified_at: now,
    })
    .execute();
  await database
    .insertInto('organizations')
    .values({
      id: orgId,
      slug: 'security-test-org',
      name: 'Security Test Org',
      kind: 'club',
      timezone: 'America/Chicago',
    })
    .execute();
  await createWithOrg(database)(
    { orgId, actor: { accountId } },
    async (trx) => {
      await trx
        .insertInto('org_memberships')
        .values({
          id: newId(),
          org_id: orgId,
          account_id: accountId,
          status: 'active',
        })
        .execute();
      await trx
        .insertInto('role_assignments')
        .values({
          id: newId(),
          org_id: orgId,
          account_id: accountId,
          role: 'owner',
          scope_type: 'org',
          pending_mfa: true,
        })
        .execute();
    },
  );
});

afterAll(async () => {
  await database.destroy();
});

describe('MFA enrollment and re-authentication', () => {
  it('confirms TOTP, activates pending roles, and reveals recovery codes once', async () => {
    const issued = await database.transaction().execute((trx) =>
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
    const active = await database
      .transaction()
      .execute((trx) => resolveSession(trx, issued.token, now));
    if (!active) throw new Error('Session missing');
    const enrollment = await beginMfaEnrollment(dependencies, active);
    expect(enrollment.otpauthUrl).toContain('otpauth://totp/');
    expect(enrollment.manualKey).toHaveLength(32);
    const step = Math.floor(now.getTime() / 30_000);
    const code = totpCode(decodeBase32(enrollment.manualKey), step);
    const recovery = await confirmMfaEnrollment(dependencies, active, code);
    expect(recovery).toHaveLength(10);
    await expect(
      confirmMfaEnrollment(dependencies, active, code),
    ).rejects.toThrow('No pending');
    const roles = await createWithOrg(database)(
      { orgId, actor: { accountId } },
      (trx) =>
        trx.selectFrom('role_assignments').select('pending_mfa').execute(),
    );
    expect(roles).toEqual([{ pending_mfa: false }]);
    const audit = await createWithOrg(database)(
      { orgId, actor: { accountId } },
      (trx) => trx.selectFrom('audit_log').select('action').execute(),
    );
    expect(audit).toEqual([{ action: 'role.mfa_activated' }]);
    expect(
      email.messages.some(
        (message) => message.subject === 'Athlentry MFA enabled',
      ),
    ).toBe(true);

    expect(
      await stepUpWithPassword(
        dependencies,
        active,
        'large cedar forest bridge 14',
      ),
    ).toBe(true);
    const stepped = await database
      .transaction()
      .execute((trx) => resolveSession(trx, issued.token, now));
    if (!stepped) throw new Error('Session missing');
    expect(await regenerateRecoveryCodes(dependencies, stepped)).toHaveLength(
      10,
    );
    now = new Date(now.getTime() + 30_000);
    const nextCode = totpCode(
      decodeBase32(enrollment.manualKey),
      Math.floor(now.getTime() / 30_000),
    );
    expect(await stepUpWithTotp(dependencies, stepped, nextCode)).toBe(true);
    expect(await stepUpWithTotp(dependencies, stepped, nextCode)).toBe(false);
  });
});
