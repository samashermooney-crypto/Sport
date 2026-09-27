import { newId } from '@shared/ids';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types';
import type { EmailSender } from '../../integrations/email/sender';

import { hashPassword, verifyPassword } from './password';
import { hasStepUp, revokeSessions } from './sessions';
import type { ActiveSession } from './sessions';
import { consumeAuthToken, issueAuthToken } from './tokens';

export interface CredentialsDependencies {
  database: Kysely<DB>;
  email: EmailSender;
  appUrl: string;
  clock: () => Date;
}

const resetNotice =
  'If this address has an account, check your email for a reset link.';

export async function requestPasswordReset(
  dependencies: CredentialsDependencies,
  email: string,
): Promise<string> {
  const address = z.email().parse(email).toLowerCase();
  const account = await dependencies.database
    .selectFrom('accounts')
    .select(['id', 'status'])
    .where('email', '=', address)
    .executeTakeFirst();
  if (account?.status === 'active') {
    const token = await dependencies.database
      .transaction()
      .execute((trx) =>
        issueAuthToken(
          trx,
          { purpose: 'reset_password', email: address, accountId: account.id },
          dependencies.clock(),
        ),
      );
    await dependencies.email.send({
      to: address,
      subject: 'Reset your Athlentry password',
      text: `Reset your password by opening ${dependencies.appUrl}/reset/${token}. This link expires in 1 hour.`,
    });
  }
  return resetNotice;
}

export async function resetPassword(
  dependencies: CredentialsDependencies,
  rawToken: string,
  newPassword: string,
): Promise<boolean> {
  const hash = await hashPassword(newPassword);
  const now = dependencies.clock();
  const email = await dependencies.database
    .transaction()
    .execute(async (trx) => {
      const token = await consumeAuthToken(
        trx,
        'reset_password',
        rawToken,
        now,
      );
      if (!token?.accountId) return null;
      const updated = await trx
        .updateTable('accounts')
        .set({ password_hash: hash, version: sql<number>`version + 1` })
        .where('id', '=', token.accountId)
        .where('email', '=', token.email)
        .where('status', '=', 'active')
        .returning('email')
        .executeTakeFirst();
      if (!updated) return null;
      await revokeSessions(trx, token.accountId, now);
      await trx
        .insertInto('security_events')
        .values({
          id: newId(),
          account_id: token.accountId,
          action: 'password.reset',
        })
        .execute();
      return updated.email;
    });
  if (!email) return false;
  await dependencies.email.send({
    to: email,
    subject: 'Your Athlentry password was reset',
    text: 'Your password was reset. If you did not make this change, contact Athlentry support immediately.',
  });
  return true;
}

export async function changePassword(
  dependencies: CredentialsDependencies,
  session: ActiveSession,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const account = await dependencies.database
    .selectFrom('accounts')
    .select(['password_hash', 'email'])
    .where('id', '=', session.accountId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (
    !account?.password_hash ||
    !(await verifyPassword(account.password_hash, currentPassword))
  ) {
    throw new Error('Current password is incorrect');
  }
  const hash = await hashPassword(newPassword);
  const now = dependencies.clock();
  await dependencies.database.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable('accounts')
      .set({ password_hash: hash, version: sql<number>`version + 1` })
      .where('id', '=', session.accountId)
      .where('password_hash', '=', account.password_hash)
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw new Error('Password changed concurrently');
    await revokeSessions(trx, session.accountId, now, session.id);
    await trx
      .insertInto('security_events')
      .values({
        id: newId(),
        account_id: session.accountId,
        action: 'password.changed',
      })
      .execute();
  });
  await dependencies.email.send({
    to: account.email,
    subject: 'Your Athlentry password changed',
    text: 'Your password was changed. If you did not make this change, contact Athlentry support immediately.',
  });
}

export async function requestEmailChange(
  dependencies: CredentialsDependencies,
  session: ActiveSession,
  proposedEmail: string,
): Promise<void> {
  const now = dependencies.clock();
  if (!hasStepUp(session, now))
    throw new Error('Recent re-authentication is required');
  const nextEmail = z.email().parse(proposedEmail).toLowerCase();
  const account = await dependencies.database
    .selectFrom('accounts')
    .select('email')
    .where('id', '=', session.accountId)
    .executeTakeFirstOrThrow();
  if (account.email === nextEmail)
    throw new Error('New email must differ from current email');
  const token = await dependencies.database
    .transaction()
    .execute(async (trx) => {
      await trx
        .updateTable('auth_tokens')
        .set({ revoked_at: now })
        .where('purpose', '=', 'email_change')
        .where('account_id', '=', session.accountId)
        .where('consumed_at', 'is', null)
        .where('revoked_at', 'is', null)
        .execute();
      return issueAuthToken(
        trx,
        {
          purpose: 'email_change',
          email: nextEmail,
          accountId: session.accountId,
          subjectKey: session.accountId,
          payload: { oldEmail: account.email },
        },
        now,
      );
    });
  await dependencies.email.send({
    to: nextEmail,
    subject: 'Verify your new Athlentry email',
    text: `Confirm your new email by opening ${dependencies.appUrl}/verify-email-change/${token}. This link expires in 1 hour.`,
  });
  await dependencies.email.send({
    to: account.email,
    subject: 'Athlentry email change requested',
    text: 'A change to your account email was requested. If this was not you, contact Athlentry support immediately.',
  });
}

export async function confirmEmailChange(
  dependencies: CredentialsDependencies,
  rawToken: string,
): Promise<boolean> {
  const now = dependencies.clock();
  const oldEmail = await dependencies.database
    .transaction()
    .execute(async (trx) => {
      const token = await consumeAuthToken(trx, 'email_change', rawToken, now);
      if (!token?.accountId || typeof token.payload.oldEmail !== 'string')
        return null;
      const updated = await trx
        .updateTable('accounts')
        .set({
          email: token.email,
          email_verified_at: now,
          version: sql<number>`version + 1`,
        })
        .where('id', '=', token.accountId)
        .where('email', '=', token.payload.oldEmail)
        .where('status', '=', 'active')
        .returning('id')
        .executeTakeFirst();
      if (!updated) return null;
      await revokeSessions(trx, token.accountId, now);
      await trx
        .insertInto('security_events')
        .values({
          id: newId(),
          account_id: token.accountId,
          action: 'email.changed',
        })
        .execute();
      return token.payload.oldEmail;
    });
  if (!oldEmail) return false;
  await dependencies.email.send({
    to: oldEmail,
    subject: 'Your Athlentry email changed',
    text: 'Your account email changed. If you did not make this change, contact Athlentry support immediately.',
  });
  return true;
}

export async function requestAccountDeletion(
  dependencies: CredentialsDependencies,
  session: ActiveSession,
  reason?: string,
): Promise<string> {
  const now = dependencies.clock();
  if (!hasStepUp(session, now))
    throw new Error('Recent re-authentication is required');
  const existing = await dependencies.database
    .selectFrom('privacy_requests')
    .select('id')
    .where('account_id', '=', session.accountId)
    .where('status', 'in', ['pending', 'in_review'])
    .executeTakeFirst();
  if (existing) return existing.id;
  const id = newId();
  await dependencies.database.transaction().execute(async (trx) => {
    await trx
      .insertInto('privacy_requests')
      .values({
        id,
        account_id: session.accountId,
        kind: 'account_deletion',
        reason: reason ?? null,
      })
      .execute();
    await trx
      .insertInto('security_events')
      .values({
        id: newId(),
        account_id: session.accountId,
        action: 'privacy.deletion_requested',
      })
      .execute();
  });
  return id;
}
