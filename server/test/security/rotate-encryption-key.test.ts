import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../src/db/kysely';
import type { DB } from '../../src/db/types';
import { createWithOrg } from '../../src/db/withOrg';
import {
  decryptRestricted,
  encryptRestricted,
  parseEncryptionKeys,
} from '../../src/lib/crypto';
import { createTestFactories } from '../factories';

let database: Kysely<DB>;
beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});
afterAll(async () => {
  await database.destroy();
});

describe('encryption-key rotation', () => {
  it('dry-runs and rotates tenant Restricted values through the operator CLI', async () => {
    const factories = createTestFactories(database);
    const actor = await factories.actor();
    const personId = await factories.person(actor);
    const oldKey = randomBytes(32);
    const nextKey = randomBytes(32);
    const oldKeyEncoded = oldKey.toString('base64');
    const nextKeyEncoded = nextKey.toString('base64');
    const original = parseEncryptionKeys(
      JSON.stringify({ previous: oldKeyEncoded }),
      'previous',
    );
    const keyJson = JSON.stringify({
      previous: oldKeyEncoded,
      next: nextKeyEncoded,
    });
    const keyring = parseEncryptionKeys(keyJson, 'next');
    const plaintext = Buffer.from('restricted medical fixture');
    const encrypted = encryptRestricted(plaintext, original);
    const medicalProfileId = '00000000-0000-4000-8000-000000000017';
    const mfaFactorId = '00000000-0000-4000-8000-000000000018';
    await factories.row(actor, 'medical_profiles', {
      id: medicalProfileId,
      org_id: actor.orgId,
      person_id: personId,
      allergies_enc: encrypted,
    });
    const encryptedMfaSecret = encryptRestricted(
      Buffer.from('totp-secret-fixture'),
      original,
    );
    await database
      .insertInto('mfa_factors')
      .values({
        id: mfaFactorId,
        account_id: actor.accountId,
        type: 'totp',
        secret_enc: encryptedMfaSecret,
        confirmed_at: new Date(),
      })
      .execute();

    const scriptPath = fileURLToPath(
      new URL('../../../scripts/rotate-encryption-key.ts', import.meta.url),
    );
    const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
    const runScript = (args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', scriptPath, ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          DATABASE_ADMIN_URL: process.env.TEST_DATABASE_URL ?? '',
          DATA_ENCRYPTION_KEYS: keyJson,
          DATA_ENCRYPTION_ACTIVE_KID: 'next',
        },
      });

    const dryRun = runScript([]);
    expect(dryRun.status, dryRun.stderr).toBe(0);
    expect(dryRun.stdout).toMatch(
      /Dry run: examined \d+ encrypted values; 2 need rotation; rotated 0\./,
    );
    const unchanged = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('medical_profiles')
        .select('allergies_enc')
        .where('id', '=', medicalProfileId)
        .executeTakeFirstOrThrow(),
    );
    expect(unchanged.allergies_enc).toEqual(encrypted);
    const unchangedMfa = await database
      .selectFrom('mfa_factors')
      .select('secret_enc')
      .where('id', '=', mfaFactorId)
      .executeTakeFirstOrThrow();
    expect(unchangedMfa.secret_enc).toEqual(encryptedMfaSecret);

    const applied = runScript(['--apply']);
    expect(applied.status, applied.stderr).toBe(0);
    expect(applied.stdout).toMatch(
      /Applied: examined \d+ encrypted values; 2 need rotation; rotated 2\./,
    );
    const rotated = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('medical_profiles')
        .select('allergies_enc')
        .where('id', '=', medicalProfileId)
        .executeTakeFirstOrThrow(),
    );
    if (!rotated.allergies_enc)
      throw new Error('Rotated Restricted value is missing');
    expect(rotated.allergies_enc[0]).toBe(4);
    expect(rotated.allergies_enc.subarray(1, 5).toString()).toBe('next');
    expect(decryptRestricted(rotated.allergies_enc, keyring)).toEqual(
      plaintext,
    );
    const rotatedMfa = await database
      .selectFrom('mfa_factors')
      .select('secret_enc')
      .where('id', '=', mfaFactorId)
      .executeTakeFirstOrThrow();
    expect(decryptRestricted(rotatedMfa.secret_enc, keyring)).toEqual(
      Buffer.from('totp-secret-fixture'),
    );
    const tenantAudit = await createWithOrg(database)(actor, (trx) =>
      trx
        .selectFrom('audit_log')
        .select(['action', 'changes'])
        .where('entity_id', '=', medicalProfileId)
        .executeTakeFirstOrThrow(),
    );
    expect(tenantAudit.action).toBe('encryption.key_rotated');
    expect(tenantAudit.changes).toMatchObject({
      encryptionKeyId: { tier: 'internal', before: 'previous', after: 'next' },
    });
    const globalAudit = await database
      .selectFrom('security_events')
      .select(['action', 'details'])
      .where('action', '=', 'encryption.key_rotated')
      .executeTakeFirstOrThrow();
    expect(globalAudit.details).toMatchObject({
      entityId: mfaFactorId,
      keyIdBefore: 'previous',
      keyIdAfter: 'next',
    });
  });
});
