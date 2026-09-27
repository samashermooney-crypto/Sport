import { hash } from '@node-rs/argon2';
import { newId } from '@shared/ids';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { EmailSender } from '../../integrations/email/sender';
import type { EncryptionKeys } from '../../lib/crypto';

import { verifyAndConsumeTotp } from './mfa';
import { verifyPassword } from './password';
import { consumeRecoveryCode } from './recovery';
import { issueSession } from './sessions';
import type { IssuedSession } from './sessions';
import { consumeAuthToken, issueAuthToken } from './tokens';

const credentialSchema = z.strictObject({
  email: z.email(),
  password: z.string(),
});

const dummyHash = hash('Athlentry unused comparison password 6', {
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

export interface SignInDependencies {
  database: Kysely<DB>;
  email: EmailSender;
  encryption: EncryptionKeys;
  appUrl: string;
  clock: () => Date;
}

export interface SignInMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export type SignInResult =
  | { status: 'session'; session: IssuedSession }
  | { status: 'mfa_required'; challengeToken: string }
  | { status: 'enrollment_required'; session: IssuedSession };

export type SignInClient = 'web' | 'ios' | 'android';

function sessionKind(client: SignInClient): 'cookie' | 'bearer' {
  return client === 'web' ? 'cookie' : 'bearer';
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid credentials');
  }
}

export class EmailVerificationRequiredError extends Error {
  constructor() {
    super('Verify your email before signing in');
  }
}

async function hasPrivilegedRole(
  database: Kysely<DB>,
  accountId: string,
): Promise<boolean> {
  const platformStaff = await database
    .selectFrom('platform_staff')
    .select('account_id')
    .where('account_id', '=', accountId)
    .where('active', '=', true)
    .executeTakeFirst();
  if (platformStaff) return true;
  const account = await database
    .selectFrom('accounts')
    .select('linked_org_ids')
    .where('id', '=', accountId)
    .executeTakeFirst();
  if (!account) return false;
  const withOrg = createWithOrg(database);
  for (const orgId of account.linked_org_ids) {
    const role = await withOrg({ orgId, actor: { accountId } }, (trx) =>
      trx
        .selectFrom('role_assignments')
        .innerJoin('org_memberships', (join) =>
          join
            .onRef('org_memberships.org_id', '=', 'role_assignments.org_id')
            .onRef(
              'org_memberships.account_id',
              '=',
              'role_assignments.account_id',
            ),
        )
        .select('role_assignments.id')
        .where('role_assignments.account_id', '=', accountId)
        .where('role_assignments.role', 'in', ['owner', 'admin', 'finance'])
        .where('role_assignments.revoked_at', 'is', null)
        .where('role_assignments.pending_mfa', '=', false)
        .where('org_memberships.status', '=', 'active')
        .executeTakeFirst(),
    );
    if (role) return true;
  }
  return false;
}

async function recordSignIn(
  trx: Transaction<DB>,
  accountId: string,
  meta: SignInMeta,
): Promise<void> {
  await trx
    .insertInto('security_events')
    .values({
      id: newId(),
      account_id: accountId,
      action: 'auth.sign_in',
      ip: meta.ip ?? null,
      user_agent: meta.userAgent ?? null,
    })
    .execute();
}

async function finishPrimaryAuth(
  dependencies: SignInDependencies,
  accountId: string,
  email: string,
  meta: SignInMeta,
  client: SignInClient,
): Promise<SignInResult> {
  const now = dependencies.clock();
  const privileged = await hasPrivilegedRole(dependencies.database, accountId);
  const factor = await dependencies.database
    .selectFrom('mfa_factors')
    .select('id')
    .where('account_id', '=', accountId)
    .where('confirmed_at', 'is not', null)
    .executeTakeFirst();
  if (factor) {
    const challengeToken = await dependencies.database
      .transaction()
      .execute((trx) =>
        issueAuthToken(
          trx,
          { purpose: 'mfa_challenge', email, accountId, payload: { client } },
          now,
        ),
      );
    return { status: 'mfa_required', challengeToken };
  }
  const session = await dependencies.database
    .transaction()
    .execute(async (trx) => {
      const issued = await issueSession(
        trx,
        {
          accountId,
          kind: sessionKind(client),
          client,
          privileged: false,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        now,
      );
      await recordSignIn(trx, accountId, meta);
      return issued;
    });
  return privileged
    ? { status: 'enrollment_required', session }
    : { status: 'session', session };
}

export async function signInWithPassword(
  dependencies: SignInDependencies,
  input: { email: string; password: string },
  meta: SignInMeta = {},
  client: SignInClient = 'web',
): Promise<SignInResult> {
  const parsed = credentialSchema.parse(input);
  const account = await dependencies.database
    .selectFrom('accounts')
    .select(['id', 'email', 'password_hash', 'email_verified_at', 'status'])
    .where('email', '=', parsed.email.toLowerCase())
    .executeTakeFirst();
  const verified = await verifyPassword(
    account?.password_hash ?? (await dummyHash),
    parsed.password,
  );
  if (
    !account ||
    !account.password_hash ||
    !verified ||
    account.status !== 'active'
  ) {
    throw new InvalidCredentialsError();
  }
  if (!account.email_verified_at) throw new EmailVerificationRequiredError();
  return finishPrimaryAuth(
    dependencies,
    account.id,
    account.email,
    meta,
    client,
  );
}

export async function requestMagicLink(
  dependencies: SignInDependencies,
  email: string,
): Promise<string> {
  const parsed = z.email().parse(email).toLowerCase();
  const account = await dependencies.database
    .selectFrom('accounts')
    .select(['id', 'status', 'email_verified_at'])
    .where('email', '=', parsed)
    .executeTakeFirst();
  if (account?.status === 'active' && account.email_verified_at) {
    const token = await dependencies.database
      .transaction()
      .execute((trx) =>
        issueAuthToken(
          trx,
          { purpose: 'magic_link', email: parsed, accountId: account.id },
          dependencies.clock(),
        ),
      );
    await dependencies.email.send({
      to: parsed,
      subject: 'Your Athlentry sign-in link',
      text: `Sign in by opening ${dependencies.appUrl}/magic/${token}. This link expires in 15 minutes.`,
    });
  }
  return 'If this address has an account, check your email for a sign-in link.';
}

export async function signInWithMagicLink(
  dependencies: SignInDependencies,
  token: string,
  meta: SignInMeta = {},
): Promise<SignInResult> {
  const consumed = await dependencies.database
    .transaction()
    .execute((trx) =>
      consumeAuthToken(trx, 'magic_link', token, dependencies.clock()),
    );
  if (!consumed?.accountId) throw new InvalidCredentialsError();
  const account = await dependencies.database
    .selectFrom('accounts')
    .select(['id', 'email', 'status', 'email_verified_at'])
    .where('id', '=', consumed.accountId)
    .executeTakeFirst();
  if (!account || account.status !== 'active' || !account.email_verified_at) {
    throw new InvalidCredentialsError();
  }
  return finishPrimaryAuth(
    dependencies,
    account.id,
    account.email,
    meta,
    'web',
  );
}

export async function completeMfaChallenge(
  dependencies: SignInDependencies,
  challengeToken: string,
  code: string,
  method: 'totp' | 'recovery',
  meta: SignInMeta = {},
  client: SignInClient = 'web',
): Promise<IssuedSession> {
  const now = dependencies.clock();
  const consumed = await dependencies.database
    .transaction()
    .execute((trx) =>
      consumeAuthToken(trx, 'mfa_challenge', challengeToken, now),
    );
  if (!consumed?.accountId || consumed.payload.client !== client)
    throw new InvalidCredentialsError();
  const accountId = consumed.accountId;
  const privileged = await hasPrivilegedRole(dependencies.database, accountId);
  return dependencies.database.transaction().execute(async (trx) => {
    const account = await trx
      .selectFrom('accounts')
      .select('status')
      .where('id', '=', accountId)
      .executeTakeFirst();
    if (account?.status !== 'active') throw new InvalidCredentialsError();
    const accepted =
      method === 'totp'
        ? await verifyAndConsumeTotp(
            trx,
            accountId,
            code,
            now.getTime(),
            dependencies.encryption,
          )
        : await consumeRecoveryCode(trx, accountId, code, now);
    if (!accepted) throw new InvalidCredentialsError();
    const session = await issueSession(
      trx,
      {
        accountId,
        kind: sessionKind(client),
        client,
        privileged,
        mfaVerifiedAt: now,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      now,
    );
    await recordSignIn(trx, accountId, meta);
    return session;
  });
}
