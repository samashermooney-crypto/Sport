import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import { sql } from 'kysely';

import { withOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import type { EmailSender } from '../../integrations/email/sender';
import { appendAuditEvent } from '../audit/service';

import { emailUnsubscribeSecret, verifyUnsubscribeToken } from './delivery';
import {
  CommunicationsAccessError,
  CommunicationsConflictError,
  requireCommunicationsRole,
} from './service';

const SMS_CONSENT_DISCLOSURE = {
  en: 'I agree to receive recurring SMS messages from this organization. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of participation.',
  es: 'Acepto recibir mensajes SMS recurrentes de esta organización. La frecuencia de los mensajes varía. Pueden aplicarse tarifas de mensajes y datos. Responde STOP para cancelar o HELP para obtener ayuda. El consentimiento no es condición para participar.',
} as const;

export async function getSmsConsent(
  context: OrgContext,
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    const account = await trx
      .selectFrom('accounts')
      .select(['phone_e164', 'phone_verified_at', 'locale'])
      .where('id', '=', context.actor.accountId)
      .executeTakeFirstOrThrow();
    const linked = await trx
      .selectFrom('person_account_links')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    const member = await trx
      .selectFrom('org_memberships')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!linked && !member)
      throw new CommunicationsAccessError('SMS settings not found');
    if (!account.phone_e164 || !account.phone_verified_at)
      return {
        accepted: false,
        phoneE164: null,
        acceptedAt: null,
        locale: account.locale === 'es' ? ('es' as const) : ('en' as const),
      };
    const result = await sql<{ action: string; accepted_at: Date }>`
      SELECT action, accepted_at FROM communication_consent_events
      WHERE org_id = ${context.orgId} AND account_id = ${context.actor.accountId} AND phone_e164 = ${account.phone_e164}
      ORDER BY accepted_at DESC, id DESC LIMIT 1
    `.execute(trx);
    const latest = result.rows[0];
    const globalStop = await trx
      .selectFrom('suppressions')
      .select('id')
      .where('org_id', 'is', null)
      .where('channel', '=', 'sms')
      .where('reason', '=', 'stop')
      .where('address', '=', account.phone_e164)
      .executeTakeFirst();
    return {
      accepted: latest?.action === 'granted' && !globalStop,
      phoneE164: account.phone_e164,
      acceptedAt:
        latest?.action === 'granted' && !globalStop
          ? latest.accepted_at.toISOString()
          : null,
      locale: account.locale === 'es' ? ('es' as const) : ('en' as const),
    };
  });
}

export async function setSmsConsent(
  context: OrgContext,
  input: { phoneE164: string; accepted: true; version: string },
  meta: { ip?: string; userAgent?: string },
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    const account = await trx
      .selectFrom('accounts')
      .select(['phone_e164', 'phone_verified_at', 'locale'])
      .where('id', '=', context.actor.accountId)
      .executeTakeFirst();
    const linked = await trx
      .selectFrom('person_account_links')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    const member = await trx
      .selectFrom('org_memberships')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!account || (!linked && !member))
      throw new CommunicationsAccessError('SMS settings not found');
    if (account.phone_e164 !== input.phoneE164 || !account.phone_verified_at)
      throw new RangeError(
        'Verify this phone number on your account before enabling SMS',
      );
    const globalStop = await trx
      .selectFrom('suppressions')
      .select('id')
      .where('org_id', 'is', null)
      .where('channel', '=', 'sms')
      .where('reason', '=', 'stop')
      .where('address', '=', input.phoneE164)
      .executeTakeFirst();
    if (globalStop)
      throw new CommunicationsConflictError(
        'Reply START from this phone to clear its SMS stop before enabling consent',
      );
    const locale = account.locale === 'es' ? 'es' : 'en';
    if (input.version !== `sms-v1-${locale}`)
      throw new RangeError('SMS consent disclosure version is invalid');
    const consentText = SMS_CONSENT_DISCLOSURE[locale];
    const now = new Date();
    await sql`INSERT INTO communication_consent_events(id, org_id, account_id, phone_e164, action, source, version, consent_text, ip, user_agent, accepted_at) VALUES (${randomUUID()}, ${context.orgId}, ${context.actor.accountId}, ${input.phoneE164}, 'granted', 'settings', ${input.version}, ${consentText}, ${meta.ip ?? null}, ${meta.userAgent ?? null}, ${now})`.execute(
      trx,
    );
    await appendAuditEvent(trx, context, {
      action: 'communication.sms_consent.grant',
      entityType: 'communication_consent',
      changes: { evidence: { tier: 'internal', after: '[recorded]' } },
    });
    return {
      accepted: true,
      phoneE164: input.phoneE164,
      acceptedAt: now.toISOString(),
      locale,
    };
  });
}

export async function revokeSmsConsent(
  context: OrgContext,
  meta: { ip?: string; userAgent?: string },
  runWithOrg: typeof withOrg = withOrg,
) {
  return runWithOrg(context, async (trx) => {
    const account = await trx
      .selectFrom('accounts')
      .select(['phone_e164', 'phone_verified_at', 'locale'])
      .where('id', '=', context.actor.accountId)
      .executeTakeFirst();
    const linked = await trx
      .selectFrom('person_account_links')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    const member = await trx
      .selectFrom('org_memberships')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!linked && !member)
      throw new CommunicationsAccessError('SMS settings not found');
    if (!account?.phone_e164 || !account.phone_verified_at)
      return {
        accepted: false,
        phoneE164: null,
        acceptedAt: null,
        locale: account?.locale === 'es' ? ('es' as const) : ('en' as const),
      };
    const now = new Date();
    await sql`INSERT INTO communication_consent_events(id, org_id, account_id, phone_e164, action, source, version, consent_text, ip, user_agent, accepted_at) VALUES (${randomUUID()}, ${context.orgId}, ${context.actor.accountId}, ${account.phone_e164}, 'revoked', 'settings', 'sms-v1-revoked', ${account.locale === 'es' ? 'El usuario desactivó los mensajes SMS en la configuración.' : 'The user disabled SMS messages in settings.'}, ${meta.ip ?? null}, ${meta.userAgent ?? null}, ${now})`.execute(
      trx,
    );
    await appendAuditEvent(trx, context, {
      action: 'communication.sms_consent.revoke',
      entityType: 'communication_consent',
      changes: { evidence: { tier: 'internal', after: '[recorded]' } },
    });
    return {
      accepted: false,
      phoneE164: account.phone_e164,
      acceptedAt: null,
      locale: account.locale === 'es' ? ('es' as const) : ('en' as const),
    };
  });
}

export type SenderIdentity = {
  displayName: string | null;
  replyTo: string | null;
  replyToVerified: boolean;
  smsComplianceText: string | null;
  version: number;
};
export type SenderUpdate = {
  displayName: string | null;
  replyTo: string | null;
  smsComplianceText: string | null;
  expectedVersion: number;
};

export async function getSenderIdentity(
  context: OrgContext,
  runWithOrg: typeof withOrg = withOrg,
): Promise<SenderIdentity> {
  return runWithOrg(context, async (trx) => {
    await requireCommunicationsRole(trx, context);
    const result = await sql<{
      display_name: string | null;
      reply_to: string | null;
      reply_to_verified_at: Date | null;
      sms_compliance_text: string | null;
      version: number;
    }>`SELECT display_name, reply_to, reply_to_verified_at, sms_compliance_text, version FROM communication_sender_identities WHERE org_id = ${context.orgId}`.execute(
      trx,
    );
    const row = result.rows[0];
    return {
      displayName: row?.display_name ?? null,
      replyTo: row?.reply_to ?? null,
      replyToVerified: Boolean(row?.reply_to_verified_at),
      smsComplianceText: row?.sms_compliance_text ?? null,
      version: row?.version ?? 0,
    };
  });
}

export async function updateSenderIdentity(
  context: OrgContext,
  input: SenderUpdate,
  appUrl: string,
  email: EmailSender,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
): Promise<{ identity: SenderIdentity; verificationSent: boolean }> {
  if (
    input.smsComplianceText &&
    (!/\bstop\b/i.test(input.smsComplianceText) ||
      !/\bhelp\b/i.test(input.smsComplianceText))
  )
    throw new RangeError(
      'SMS compliance text must explain STOP and HELP replies',
    );
  const identity = await runWithOrg(context, async (trx) => {
    await requireCommunicationsRole(trx, context);
    const result = await sql<{
      display_name: string | null;
      reply_to: string | null;
      reply_to_verified_at: Date | null;
      sms_compliance_text: string | null;
      version: number;
    }>`SELECT display_name, reply_to, reply_to_verified_at, sms_compliance_text, version FROM communication_sender_identities WHERE org_id = ${context.orgId} FOR UPDATE`.execute(
      trx,
    );
    const current = result.rows[0];
    const currentVersion = current?.version ?? 0;
    if (input.expectedVersion !== currentVersion)
      throw new CommunicationsConflictError(
        'Sender identity was changed by another administrator',
      );
    const needsVerification = Boolean(
      input.replyTo &&
      (input.replyTo !== current?.reply_to || !current.reply_to_verified_at),
    );
    const verification =
      input.replyTo && needsVerification
        ? {
            token: randomBytes(32).toString('base64url'),
            replyTo: input.replyTo,
          }
        : null;
    const token = verification?.token ?? null;
    const tokenHash = token
      ? createHash('sha256').update(token).digest('hex')
      : null;
    const version = currentVersion + 1;
    if (current) {
      await sql`UPDATE communication_sender_identities SET display_name = ${input.displayName}, reply_to = ${input.replyTo}, sms_compliance_text = ${input.smsComplianceText}, reply_to_verification_hash = ${tokenHash ? Buffer.from(tokenHash, 'hex') : null}, reply_to_verification_expires_at = ${token ? new Date(now.getTime() + 30 * 60_000) : null}, reply_to_verified_at = ${input.replyTo && !needsVerification ? current.reply_to_verified_at : null}, version = ${version}, updated_by = ${context.actor.accountId} WHERE org_id = ${context.orgId}`.execute(
        trx,
      );
    } else {
      await sql`INSERT INTO communication_sender_identities(org_id, display_name, reply_to, sms_compliance_text, reply_to_verification_hash, reply_to_verification_expires_at, reply_to_verified_at, version, updated_by) VALUES (${context.orgId}, ${input.displayName}, ${input.replyTo}, ${input.smsComplianceText}, ${tokenHash ? Buffer.from(tokenHash, 'hex') : null}, ${token ? new Date(now.getTime() + 30 * 60_000) : null}, NULL, ${version}, ${context.actor.accountId})`.execute(
        trx,
      );
    }
    await appendAuditEvent(trx, context, {
      action: 'communication.sender_identity.update',
      entityType: 'communication_sender_identity',
      changes: {
        display_name: {
          tier: 'internal',
          before: current?.display_name ?? null,
          after: input.displayName,
        },
        reply_to: {
          tier: 'internal',
          after: input.replyTo ? '[verification requested]' : null,
        },
      },
    });
    return {
      identity: {
        displayName: input.displayName,
        replyTo: input.replyTo,
        replyToVerified: Boolean(
          input.replyTo && !needsVerification && current?.reply_to_verified_at,
        ),
        smsComplianceText: input.smsComplianceText,
        version,
      },
      organization: await trx
        .selectFrom('organizations')
        .select(['name', 'email'])
        .where('id', '=', context.orgId)
        .executeTakeFirstOrThrow(),
      verification,
    };
  });
  if (!identity.verification)
    return { identity: identity.identity, verificationSent: false };
  const verificationTokenSignature = signSenderVerification({
    orgId: context.orgId,
    accountId: context.actor.accountId,
    replyTo: identity.verification.replyTo,
    expiresAt: now.getTime() + 30 * 60_000,
    token: identity.verification.token,
  });
  await email.send({
    to: identity.verification.replyTo,
    subject: `Verify ${identity.organization.name} reply-to address`,
    text: `Open this link to verify the reply-to address: ${appUrl.replace(/\/$/, '')}/api/v1/communications/sender/verify/${verificationTokenSignature}`,
    kind: 'transactional',
    idempotencyKey: `sender-verify:${context.orgId}:${String(identity.identity.version)}`,
  });
  return { identity: identity.identity, verificationSent: true };
}

type SenderVerificationClaims = {
  orgId: string;
  accountId: string;
  replyTo: string;
  expiresAt: number;
  token: string;
};
function signSenderVerification(claims: SenderVerificationClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', emailUnsubscribeSecret())
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function checkSenderVerificationSignature(
  token: string,
): SenderVerificationClaims {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra)
    throw new Error('Verification token is invalid');
  const expected = createHmac('sha256', emailUnsubscribeSecret())
    .update(payload)
    .digest('base64url');
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (
    actualBytes.length !== expectedBytes.length ||
    !timingSafeEqual(actualBytes, expectedBytes)
  )
    throw new Error('Verification token is invalid');
  const claims = JSON.parse(
    Buffer.from(payload, 'base64url').toString(),
  ) as SenderVerificationClaims;
  if (
    !claims.orgId ||
    !claims.accountId ||
    !claims.replyTo ||
    claims.expiresAt < Date.now()
  )
    throw new Error('Verification token expired');
  return claims;
}

export async function verifySenderIdentity(
  token: string,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  const claims = checkSenderVerificationSignature(token);
  const tokenHash = createHash('sha256').update(claims.token).digest();
  return runWithOrg(
    { orgId: claims.orgId, actor: { accountId: claims.accountId } },
    async (trx) => {
      const row = await sql<{
        reply_to: string;
        reply_to_verification_hash: Buffer | null;
        reply_to_verification_expires_at: Date | null;
        version: number;
      }>`SELECT reply_to, reply_to_verification_hash, reply_to_verification_expires_at, version FROM communication_sender_identities WHERE org_id = ${claims.orgId} FOR UPDATE`.execute(
        trx,
      );
      const identity = row.rows[0];
      if (
        !identity ||
        identity.reply_to !== claims.replyTo ||
        !identity.reply_to_verification_hash ||
        !identity.reply_to_verification_expires_at ||
        identity.reply_to_verification_expires_at <= now ||
        !timingSafeEqual(identity.reply_to_verification_hash, tokenHash)
      )
        throw new Error('Reply-to verification is invalid or expired');
      await sql`UPDATE communication_sender_identities SET reply_to_verified_at = ${now}, reply_to_verification_hash = NULL, reply_to_verification_expires_at = NULL, version = version + 1 WHERE org_id = ${claims.orgId}`.execute(
        trx,
      );
      await appendAuditEvent(
        trx,
        { orgId: claims.orgId, actor: { accountId: claims.accountId } },
        {
          action: 'communication.sender_identity.verify',
          entityType: 'communication_sender_identity',
          changes: { reply_to_verified: { tier: 'internal', after: true } },
        },
      );
      return { verified: true, replyTo: identity.reply_to };
    },
  );
}

export async function unsubscribeFromCategory(
  token: string,
  now = new Date(),
  runWithOrg: typeof withOrg = withOrg,
) {
  const claims = verifyUnsubscribeToken(token, now);
  const context = {
    orgId: claims.orgId,
    actor: { accountId: claims.accountId },
  };
  return runWithOrg(context, async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${claims.orgId}:${claims.accountId}:${claims.category}`}, 0))`.execute(
      trx,
    );
    const current = await trx
      .selectFrom('communication_preferences')
      .select(['id', 'version'])
      .where('org_id', '=', claims.orgId)
      .where('account_id', '=', claims.accountId)
      .where('category', '=', claims.category)
      .where('channel', '=', 'email')
      .executeTakeFirst();
    if (current) {
      await trx
        .updateTable('communication_preferences')
        .set({ enabled: false, version: current.version + 1 })
        .where('org_id', '=', claims.orgId)
        .where('id', '=', current.id)
        .execute();
    } else {
      await trx
        .insertInto('communication_preferences')
        .values({
          id: randomUUID(),
          org_id: claims.orgId,
          account_id: claims.accountId,
          category: claims.category,
          channel: 'email',
          enabled: false,
        })
        .onConflict((conflict) =>
          conflict
            .columns(['org_id', 'account_id', 'category', 'channel'])
            .doNothing(),
        )
        .execute();
    }
    await appendAuditEvent(trx, context, {
      action: 'communication.preference.unsubscribe',
      entityType: 'communication_preference',
      changes: {
        category: { tier: 'internal', after: claims.category },
        channel: { tier: 'internal', after: 'email' },
      },
    });
    const account = await trx
      .selectFrom('accounts')
      .select('locale')
      .where('id', '=', claims.accountId)
      .executeTakeFirst();
    return {
      orgId: claims.orgId,
      category: claims.category,
      channel: 'email' as const,
      enabled: false,
      locale: account?.locale === 'es' ? ('es' as const) : ('en' as const),
    };
  });
}
