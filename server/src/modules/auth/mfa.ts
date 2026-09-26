import { newId } from '@shared/ids';
import type { Transaction } from 'kysely';

import type { DB } from '../../db/types';
import { decryptRestricted } from '../../lib/crypto';
import type { EncryptionKeys } from '../../lib/crypto';

import { decodeBase32, verifyTotp } from './totp';

export async function verifyAndConsumeTotp(
  trx: Transaction<DB>,
  accountId: string,
  code: string,
  nowMilliseconds: number,
  encryption: EncryptionKeys,
  confirmEnrollment = false,
): Promise<boolean> {
  const factor = await trx
    .selectFrom('mfa_factors')
    .select(['id', 'secret_enc', 'confirmed_at', 'last_used_step'])
    .where('account_id', '=', accountId)
    .where('type', '=', 'totp')
    .forUpdate()
    .executeTakeFirst();
  if (!factor || (!factor.confirmed_at && !confirmEnrollment)) return false;

  await trx
    .insertInto('security_events')
    .values({
      id: newId(),
      account_id: accountId,
      action: 'mfa.secret_read',
    })
    .execute();
  const secret = decodeBase32(
    decryptRestricted(factor.secret_enc, encryption).toString('utf8'),
  );
  const step = verifyTotp(secret, code, nowMilliseconds, factor.last_used_step);
  if (step === null) return false;

  const update = trx
    .updateTable('mfa_factors')
    .set({ last_used_step: step })
    .where('id', '=', factor.id);
  if (confirmEnrollment && !factor.confirmed_at) {
    await update.set({ confirmed_at: new Date(nowMilliseconds) }).execute();
  } else {
    await update.execute();
  }
  return true;
}
