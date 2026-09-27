import type { DiscountCode } from '@shared/algorithms/pricing';
import { newId } from '@shared/ids';
import { sql } from 'kysely';
import { z } from 'zod';

import type { OrgTransaction } from '../../db/withOrg.js';

const appliesToSchema = z
  .object({
    programIds: z.array(z.uuid()).optional(),
    offeringIds: z.array(z.uuid()).optional(),
    productVariantIds: z.array(z.uuid()).optional(),
  })
  .strict();

export async function reserveDiscountCode(
  trx: OrgTransaction,
  input: {
    orgId: string;
    checkoutId: string;
    accountId: string;
    code: string;
    offerings: readonly { offeringId: string; programId: string }[];
    now: Date;
  },
): Promise<DiscountCode> {
  const codeText = z.string().trim().min(1).max(64).parse(input.code);
  const code = await trx
    .selectFrom('discount_codes')
    .select([
      'id',
      'kind',
      'value',
      'applies_to',
      'starts_at',
      'ends_at',
      'max_redemptions',
      'max_per_account',
      'stackable',
      'active',
    ])
    .where('org_id', '=', input.orgId)
    .where('code', '=', codeText)
    .forUpdate()
    .executeTakeFirst();
  if (
    !code ||
    !code.active ||
    (code.starts_at && code.starts_at > input.now) ||
    (code.ends_at && code.ends_at <= input.now)
  )
    throw new Error('Discount code is unavailable');
  const scope = appliesToSchema.safeParse(code.applies_to);
  if (!scope.success) throw new Error('Discount code scope is unsupported');
  const eligible = input.offerings
    .filter(
      (offering) =>
        (!scope.data.offeringIds &&
          !scope.data.programIds &&
          !scope.data.productVariantIds) ||
        scope.data.offeringIds?.includes(offering.offeringId) ||
        scope.data.programIds?.includes(offering.programId),
    )
    .map((offering) => offering.offeringId);
  if (!eligible.length) throw new Error('Discount code is ineligible for cart');
  const checkout = await trx
    .selectFrom('checkouts')
    .select(['account_id', 'expires_at'])
    .where('org_id', '=', input.orgId)
    .where('id', '=', input.checkoutId)
    .executeTakeFirstOrThrow();
  if (
    checkout.account_id !== input.accountId ||
    checkout.expires_at <= input.now
  )
    throw new Error('Discount checkout has expired');
  const existing = await sql<{
    expires_at: Date;
    released_at: Date | null;
    redeemed_at: Date | null;
  }>`
    SELECT expires_at, released_at, redeemed_at
    FROM discount_code_reservations
    WHERE org_id = ${input.orgId}::uuid
      AND checkout_id = ${input.checkoutId}::uuid
      AND discount_code_id = ${code.id}::uuid FOR UPDATE
  `.execute(trx);
  if (existing.rows[0]) {
    const reservation = existing.rows[0];
    if (
      reservation.released_at ||
      reservation.redeemed_at ||
      reservation.expires_at <= input.now
    )
      throw new Error('Discount reservation is no longer available');
  } else {
    const counts = await sql<{
      redeemed_total: number;
      reserved_total: number;
      redeemed_account: number;
      reserved_account: number;
    }>`
      SELECT
        (SELECT count(*)::integer FROM discount_redemptions
          WHERE org_id = ${input.orgId}::uuid
            AND discount_code_id = ${code.id}::uuid) AS redeemed_total,
        (SELECT count(*)::integer FROM discount_code_reservations
          WHERE org_id = ${input.orgId}::uuid
            AND discount_code_id = ${code.id}::uuid
            AND released_at IS NULL AND redeemed_at IS NULL
            AND expires_at > ${input.now}) AS reserved_total,
        (SELECT count(*)::integer FROM discount_redemptions
          WHERE org_id = ${input.orgId}::uuid
            AND discount_code_id = ${code.id}::uuid
            AND account_id = ${input.accountId}::uuid) AS redeemed_account,
        (SELECT count(*)::integer FROM discount_code_reservations
          WHERE org_id = ${input.orgId}::uuid
            AND discount_code_id = ${code.id}::uuid
            AND account_id = ${input.accountId}::uuid
            AND released_at IS NULL AND redeemed_at IS NULL
            AND expires_at > ${input.now}) AS reserved_account
    `.execute(trx);
    const count = counts.rows[0];
    if (
      !count ||
      (code.max_redemptions !== null &&
        count.redeemed_total + count.reserved_total >= code.max_redemptions) ||
      (code.max_per_account !== null &&
        count.redeemed_account + count.reserved_account >= code.max_per_account)
    )
      throw new Error('Discount code redemption limit reached');
    await sql`
      INSERT INTO discount_code_reservations
        (id, org_id, discount_code_id, checkout_id, account_id, expires_at)
      VALUES (${newId()}::uuid, ${input.orgId}::uuid, ${code.id}::uuid,
        ${input.checkoutId}::uuid, ${input.accountId}::uuid,
        ${checkout.expires_at})
    `.execute(trx);
  }
  return {
    id: code.id,
    kind: code.kind as 'fixed' | 'percent',
    value: code.value,
    stackable: code.stackable,
    eligibleOfferingIds: [...new Set(eligible)],
  };
}
