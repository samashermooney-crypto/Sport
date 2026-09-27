import { createHash, randomBytes } from 'node:crypto';

import { newId } from '@shared/ids';
import {
  authTokenPayloadSchema,
  authTokenPurposeSchema,
} from '@shared/schemas/auth';
import type { AuthTokenPurpose } from '@shared/schemas/auth';
import type { Transaction } from 'kysely';

import type { DB } from '../../db/types';
import type { Json } from '../../db/types';

const lifetimeMilliseconds: Record<AuthTokenPurpose, number> = {
  verify_email: 24 * 60 * 60 * 1_000,
  magic_link: 15 * 60 * 1_000,
  reset_password: 60 * 60 * 1_000,
  org_invitation: 7 * 24 * 60 * 60 * 1_000,
  guardian_invitation: 7 * 24 * 60 * 60 * 1_000,
  athlete_account_invitation: 7 * 24 * 60 * 60 * 1_000,
  claim_person: 7 * 24 * 60 * 60 * 1_000,
  email_change: 60 * 60 * 1_000,
  mfa_challenge: 5 * 60 * 1_000,
};

function digest(raw: string): Buffer {
  return createHash('sha256').update(raw).digest();
}

export interface IssueAuthToken {
  purpose: AuthTokenPurpose;
  email: string;
  accountId?: string;
  orgId?: string;
  subjectKey?: string;
  payload?: unknown;
  createdBy?: string;
}

export async function issueAuthToken(
  trx: Transaction<DB>,
  input: IssueAuthToken,
  now: Date,
): Promise<string> {
  const purpose = authTokenPurposeSchema.parse(input.purpose);
  const email = input.email.trim().toLowerCase();
  const payload = authTokenPayloadSchema.parse(input.payload ?? {});
  const orgId = input.orgId ?? null;
  const subjectKey = input.subjectKey ?? '';
  if (!email || subjectKey.length > 256)
    throw new RangeError('Invalid token subject');

  let revocations = trx
    .updateTable('auth_tokens')
    .set({ revoked_at: now })
    .where('purpose', '=', purpose)
    .where('email', '=', email)
    .where('subject_key', '=', subjectKey)
    .where('consumed_at', 'is', null)
    .where('revoked_at', 'is', null);
  revocations = orgId
    ? revocations.where('org_id', '=', orgId)
    : revocations.where('org_id', 'is', null);
  await revocations.execute();

  const raw = randomBytes(32).toString('base64url');
  await trx
    .insertInto('auth_tokens')
    .values({
      id: newId(),
      purpose,
      token_hash: digest(raw),
      account_id: input.accountId ?? null,
      email,
      org_id: orgId,
      subject_key: subjectKey,
      payload: payload as Json,
      expires_at: new Date(now.getTime() + lifetimeMilliseconds[purpose]),
      created_by: input.createdBy ?? null,
    })
    .execute();
  return raw;
}

export interface ConsumedAuthToken {
  accountId: string | null;
  email: string;
  orgId: string | null;
  payload: ReturnType<typeof authTokenPayloadSchema.parse>;
}

export async function consumeAuthToken(
  trx: Transaction<DB>,
  purpose: AuthTokenPurpose,
  raw: string,
  now: Date,
): Promise<ConsumedAuthToken | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const token = await trx
    .updateTable('auth_tokens')
    .set({ consumed_at: now })
    .where('purpose', '=', authTokenPurposeSchema.parse(purpose))
    .where('token_hash', '=', digest(raw))
    .where('consumed_at', 'is', null)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now)
    .returning(['account_id', 'email', 'org_id', 'payload'])
    .executeTakeFirst();
  if (!token) return null;
  return {
    accountId: token.account_id,
    email: token.email,
    orgId: token.org_id,
    payload: authTokenPayloadSchema.parse(token.payload),
  };
}
