import type { Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase } from '../../db/kysely';
import type { DB } from '../../db/types';
import { AlwaysPassCaptcha } from '../../integrations/captcha/provider';
import { FakeEmailSender } from '../../integrations/email/sender';

import { localLegalDocuments } from './legal';
import { signUp, Under13Error, verifyEmail } from './signup';

const now = new Date('2026-09-26T18:00:00Z');
const email = new FakeEmailSender();
let database: Kysely<DB>;

beforeAll(() => {
  database = createDatabase(process.env.TEST_DATABASE_APP_URL ?? '');
});

afterAll(async () => {
  await database.destroy();
});

describe('signup and email verification', () => {
  const baseInput = {
    email: 'OWNER@example.invalid',
    password: 'safe snow-covered bicycle 44',
    firstName: 'New',
    lastName: 'Owner',
    dateOfBirth: '2000-01-01',
    termsAccepted: true as const,
    privacyAccepted: true as const,
    captchaToken: 'test-token',
  };

  it('rejects under-13 signup and captures both exact document consents', async () => {
    const dependencies = {
      database,
      captcha: new AlwaysPassCaptcha(),
      email,
      appUrl: 'http://127.0.0.1:5173',
      clock: () => now,
    };
    await expect(
      signUp(dependencies, {
        ...baseInput,
        dateOfBirth: '2013-09-27',
      }),
    ).rejects.toBeInstanceOf(Under13Error);
    const notice = await signUp(dependencies, baseInput, {
      ip: '127.0.0.1',
      userAgent: 'Athlentry test',
    });
    expect(notice).toContain('check your email');
    expect(email.messages).toHaveLength(1);
    const account = await database
      .selectFrom('accounts')
      .select(['id', 'email', 'email_verified_at'])
      .where('email', '=', 'owner@example.invalid')
      .executeTakeFirstOrThrow();
    expect(account.email_verified_at).toBeNull();
    const consents = await database
      .selectFrom('account_consents')
      .select(['kind', 'document_text', 'ip'])
      .where('account_id', '=', account.id)
      .orderBy('kind')
      .execute();
    expect(consents).toEqual([
      {
        kind: 'privacy',
        document_text: localLegalDocuments.privacy.text,
        ip: '127.0.0.1',
      },
      {
        kind: 'terms',
        document_text: localLegalDocuments.terms.text,
        ip: '127.0.0.1',
      },
    ]);
    expect(await signUp(dependencies, baseInput)).toBe(notice);
    expect(email.messages).toHaveLength(1);

    const raw = email.messages[0]?.text.match(
      /\/verify\/([A-Za-z0-9_-]{43})/,
    )?.[1];
    if (!raw) throw new Error('Verification token missing from preview email');
    expect(await verifyEmail(database, raw, now)).toBe(true);
    expect(await verifyEmail(database, raw, now)).toBe(false);
  });
});
