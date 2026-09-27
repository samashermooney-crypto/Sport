import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { EmailSender } from '../../integrations/email/sender';
import { encryptRestricted } from '../../lib/crypto';
import type { EncryptionKeys } from '../../lib/crypto';

import { verifyAndConsumeTotp } from './mfa';
import { verifyPassword } from './password';
import { generateRecoveryCodes } from './recovery';
import { hasStepUp, revokeSessions, stepUpSession } from './sessions';
import type { ActiveSession } from './sessions';
import { newTotpSecret } from './totp';

export interface SecurityDependencies {
  database: Kysely<DB>;
  encryption: EncryptionKeys;
  email: EmailSender;
  clock: () => Date;
}

export interface MfaEnrollment {
  manualKey: string;
  otpauthUrl: string;
}

export async function beginMfaEnrollment(
  dependencies: SecurityDependencies,
  session: ActiveSession,
): Promise<MfaEnrollment> {
  const secret = newTotpSecret();
  const encrypted = encryptRestricted(
    Buffer.from(secret),
    dependencies.encryption,
  );
  const email = await dependencies.database
    .transaction()
    .execute(async (trx) => {
      const account = await trx
        .selectFrom('accounts')
        .select('email')
        .where('id', '=', session.accountId)
        .where('status', '=', 'active')
        .executeTakeFirstOrThrow();
      const factor = await trx
        .selectFrom('mfa_factors')
        .select(['id', 'confirmed_at'])
        .where('account_id', '=', session.accountId)
        .where('type', '=', 'totp')
        .forUpdate()
        .executeTakeFirst();
      if (factor?.confirmed_at) throw new Error('MFA is already enrolled');
      if (factor) {
        await trx
          .updateTable('mfa_factors')
          .set({ secret_enc: encrypted, last_used_step: null })
          .where('id', '=', factor.id)
          .execute();
      } else {
        await trx
          .insertInto('mfa_factors')
          .values({
            id: newId(),
            account_id: session.accountId,
            type: 'totp',
            secret_enc: encrypted,
          })
          .execute();
      }
      await trx
        .insertInto('security_events')
        .values({
          id: newId(),
          account_id: session.accountId,
          action: 'mfa.enrollment_started',
        })
        .execute();
      return account.email;
    });
  const label = encodeURIComponent(`Athlentry:${email}`);
  const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=Athlentry&algorithm=SHA1&digits=6&period=30`;
  return { manualKey: secret, otpauthUrl };
}

async function activatePendingRoles(
  database: Kysely<DB>,
  accountId: string,
): Promise<void> {
  const account = await database
    .selectFrom('accounts')
    .select('linked_org_ids')
    .where('id', '=', accountId)
    .executeTakeFirstOrThrow();
  const withOrg = createWithOrg(database);
  for (const orgId of account.linked_org_ids) {
    await withOrg({ orgId, actor: { accountId } }, async (trx) => {
      const activated = await trx
        .updateTable('role_assignments')
        .set({ pending_mfa: false })
        .where('org_id', '=', orgId)
        .where('account_id', '=', accountId)
        .where('pending_mfa', '=', true)
        .where('revoked_at', 'is', null)
        .returning('id')
        .execute();
      for (const role of activated) {
        await trx
          .insertInto('audit_log')
          .values({
            id: newId(),
            org_id: orgId,
            actor_account_id: accountId,
            action: 'role.mfa_activated',
            entity_type: 'role_assignment',
            entity_id: role.id,
            changes: { pending_mfa: { from: true, to: false } },
          })
          .execute();
      }
    });
  }
}

export async function confirmMfaEnrollment(
  dependencies: SecurityDependencies,
  session: ActiveSession,
  code: string,
): Promise<string[]> {
  const now = dependencies.clock();
  const codes = await dependencies.database
    .transaction()
    .execute(async (trx) => {
      const factor = await trx
        .selectFrom('mfa_factors')
        .select('confirmed_at')
        .where('account_id', '=', session.accountId)
        .where('type', '=', 'totp')
        .forUpdate()
        .executeTakeFirst();
      if (!factor || factor.confirmed_at)
        throw new Error('No pending MFA enrollment');
      if (
        !(await verifyAndConsumeTotp(
          trx,
          session.accountId,
          code,
          now.getTime(),
          dependencies.encryption,
          true,
        ))
      ) {
        throw new Error('Invalid authenticator code');
      }
      const generated = await generateRecoveryCodes(trx, session.accountId);
      await revokeSessions(trx, session.accountId, now, session.id);
      await trx
        .insertInto('security_events')
        .values({
          id: newId(),
          account_id: session.accountId,
          action: 'mfa.enrolled',
        })
        .execute();
      return generated;
    });
  await activatePendingRoles(dependencies.database, session.accountId);
  const account = await dependencies.database
    .selectFrom('accounts')
    .select('email')
    .where('id', '=', session.accountId)
    .executeTakeFirstOrThrow();
  await dependencies.email.send({
    to: account.email,
    subject: 'Athlentry MFA enabled',
    text: 'Multi-factor authentication was enabled on your account. If you did not make this change, contact Athlentry support immediately.',
  });
  return codes;
}

export async function regenerateRecoveryCodes(
  dependencies: SecurityDependencies,
  session: ActiveSession,
): Promise<string[]> {
  const now = dependencies.clock();
  if (!hasStepUp(session, now))
    throw new Error('Recent re-authentication is required');
  const codes = await dependencies.database
    .transaction()
    .execute(async (trx) => {
      const factor = await trx
        .selectFrom('mfa_factors')
        .select('id')
        .where('account_id', '=', session.accountId)
        .where('confirmed_at', 'is not', null)
        .executeTakeFirst();
      if (!factor) throw new Error('MFA is not enrolled');
      const codes = await generateRecoveryCodes(trx, session.accountId);
      await revokeSessions(trx, session.accountId, now, session.id);
      return codes;
    });
  const account = await dependencies.database
    .selectFrom('accounts')
    .select('email')
    .where('id', '=', session.accountId)
    .executeTakeFirstOrThrow();
  await dependencies.email.send({
    to: account.email,
    subject: 'Athlentry recovery codes changed',
    text: 'Your MFA recovery codes were regenerated. If you did not make this change, contact Athlentry support immediately.',
  });
  return codes;
}

export async function stepUpWithPassword(
  dependencies: SecurityDependencies,
  session: ActiveSession,
  password: string,
): Promise<boolean> {
  const account = await dependencies.database
    .selectFrom('accounts')
    .select('password_hash')
    .where('id', '=', session.accountId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (
    !account?.password_hash ||
    !(await verifyPassword(account.password_hash, password))
  )
    return false;
  return dependencies.database
    .transaction()
    .execute((trx) =>
      stepUpSession(trx, session.id, session.accountId, dependencies.clock()),
    );
}

export async function stepUpWithTotp(
  dependencies: SecurityDependencies,
  session: ActiveSession,
  code: string,
): Promise<boolean> {
  const now = dependencies.clock();
  return dependencies.database.transaction().execute(async (trx) => {
    if (
      !(await verifyAndConsumeTotp(
        trx,
        session.accountId,
        code,
        now.getTime(),
        dependencies.encryption,
      ))
    ) {
      return false;
    }
    return stepUpSession(trx, session.id, session.accountId, now);
  });
}
