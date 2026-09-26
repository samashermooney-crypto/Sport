import { createHash, randomBytes } from 'node:crypto';

import { newId } from '@shared/ids';
import type { Transaction } from 'kysely';

import type { DB } from '../../db/types';

import { encodeBase32 } from './totp';

function normalizedCode(code: string): string | null {
  const normalized = code.replaceAll('-', '').toUpperCase();
  return /^[A-Z2-7]{16}$/.test(normalized) ? normalized : null;
}

function digest(code: string): Buffer {
  return createHash('sha256').update(code).digest();
}

export async function generateRecoveryCodes(
  trx: Transaction<DB>,
  accountId: string,
): Promise<string[]> {
  await trx
    .deleteFrom('mfa_recovery_codes')
    .where('account_id', '=', accountId)
    .execute();
  const codes = Array.from({ length: 10 }, () => encodeBase32(randomBytes(10)));
  await trx
    .insertInto('mfa_recovery_codes')
    .values(
      codes.map((code) => ({
        id: newId(),
        account_id: accountId,
        code_hash: digest(code),
      })),
    )
    .execute();
  await trx
    .insertInto('security_events')
    .values({
      id: newId(),
      account_id: accountId,
      action: 'mfa.recovery_regenerated',
    })
    .execute();
  return codes.map((code) => code.match(/.{1,4}/g)?.join('-') ?? code);
}

export async function consumeRecoveryCode(
  trx: Transaction<DB>,
  accountId: string,
  submitted: string,
  now: Date,
): Promise<boolean> {
  const code = normalizedCode(submitted);
  if (!code) return false;
  const used = await trx
    .updateTable('mfa_recovery_codes')
    .set({ used_at: now })
    .where('account_id', '=', accountId)
    .where('code_hash', '=', digest(code))
    .where('used_at', 'is', null)
    .returning('id')
    .executeTakeFirst();
  if (!used) return false;
  await trx
    .insertInto('security_events')
    .values({
      id: newId(),
      account_id: accountId,
      action: 'mfa.recovery_used',
    })
    .execute();
  return true;
}
