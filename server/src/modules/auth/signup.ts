import { Temporal } from '@js-temporal/polyfill';
import { ageOnDate, orgToday } from '@shared/dates';
import { newId } from '@shared/ids';
import { signUpSchema } from '@shared/schemas/auth';
import type { SignUpInput } from '@shared/schemas/auth';
import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';
import type { CaptchaProvider } from '../../integrations/captcha/provider';
import type { EmailSender } from '../../integrations/email/sender';

import { localLegalDocuments } from './legal';
import { hashPassword } from './password';
import { consumeAuthToken, issueAuthToken } from './tokens';

export interface SignUpDependencies {
  database: Kysely<DB>;
  captcha: CaptchaProvider;
  email: EmailSender;
  appUrl: string;
  clock: () => Date;
}

export interface SignUpMeta {
  ip?: string;
  userAgent?: string;
}

export class Under13Error extends Error {
  constructor() {
    super('A parent or guardian must create the account.');
  }
}

const notice =
  'If this address can be registered, check your email for a verification link.';

export async function signUp(
  dependencies: SignUpDependencies,
  input: SignUpInput,
  meta: SignUpMeta = {},
): Promise<string> {
  const parsed = signUpSchema.parse(input);
  const now = dependencies.clock();
  const today = orgToday(
    'UTC',
    Temporal.Instant.fromEpochMilliseconds(now.getTime()),
  );
  if (ageOnDate(parsed.dateOfBirth, today) < 13) throw new Under13Error();
  if (!(await dependencies.captcha.verify(parsed.captchaToken, meta.ip))) {
    throw new Error('Captcha verification failed');
  }
  const passwordHash = await hashPassword(parsed.password);
  const email = parsed.email.toLowerCase();
  const existing = await dependencies.database
    .selectFrom('accounts')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirst();
  if (existing) return notice;

  const accountId = newId();
  let rawToken: string;
  try {
    rawToken = await dependencies.database
      .transaction()
      .execute(async (trx) => {
        await trx
          .insertInto('accounts')
          .values({
            id: accountId,
            email,
            password_hash: passwordHash,
            first_name: parsed.firstName,
            last_name: parsed.lastName,
            date_of_birth: parsed.dateOfBirth,
          })
          .execute();
        await trx
          .insertInto('account_consents')
          .values([
            {
              id: newId(),
              account_id: accountId,
              kind: 'terms',
              document_version: localLegalDocuments.terms.version,
              document_text: localLegalDocuments.terms.text,
              accepted_at: now,
              ip: meta.ip ?? null,
              user_agent: meta.userAgent ?? null,
            },
            {
              id: newId(),
              account_id: accountId,
              kind: 'privacy',
              document_version: localLegalDocuments.privacy.version,
              document_text: localLegalDocuments.privacy.text,
              accepted_at: now,
              ip: meta.ip ?? null,
              user_agent: meta.userAgent ?? null,
            },
          ])
          .execute();
        await trx
          .insertInto('security_events')
          .values({
            id: newId(),
            account_id: accountId,
            action: 'account.created',
            ip: meta.ip ?? null,
            user_agent: meta.userAgent ?? null,
          })
          .execute();
        return issueAuthToken(
          trx,
          {
            purpose: 'verify_email',
            email,
            accountId,
          },
          now,
        );
      });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === '23505')
      return notice;
    throw error;
  }
  await dependencies.email.send({
    to: email,
    subject: 'Verify your Athlentry email',
    text: `Verify your email by opening ${dependencies.appUrl}/verify/${rawToken}. This link expires in 24 hours.`,
  });
  return notice;
}

export async function verifyEmail(
  database: Kysely<DB>,
  rawToken: string,
  now: Date,
): Promise<boolean> {
  return database.transaction().execute(async (trx) => {
    const token = await consumeAuthToken(trx, 'verify_email', rawToken, now);
    if (!token?.accountId) return false;
    const updated = await trx
      .updateTable('accounts')
      .set({ email_verified_at: now })
      .where('id', '=', token.accountId)
      .where('email', '=', token.email)
      .where('status', '=', 'active')
      .returning('id')
      .executeTakeFirst();
    if (!updated) return false;
    await trx
      .insertInto('security_events')
      .values({
        id: newId(),
        account_id: updated.id,
        action: 'email.verified',
      })
      .execute();
    return true;
  });
}
