import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { Temporal } from '@js-temporal/polyfill';
import { orgToday } from '@shared/dates';
import { newId } from '@shared/ids';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types';
import { createWithOrg } from '../../db/withOrg';
import type { OrgContext } from '../../db/withOrg';
import { LocalDiskStorage } from '../../integrations/storage/storage';
import type { Storage } from '../../integrations/storage/storage';
import { decryptRestricted, encryptRestricted } from '../../lib/crypto';
import type { EncryptionKeys } from '../../lib/crypto';

import { logEligibilityAudit } from './policy';

export interface CardDependencies {
  database: Kysely<DB>;
  encryption: EncryptionKeys;
  clock: () => Date;
  appUrl: string;
  localStorage?: Pick<Storage, 'get'>;
}

export class CardError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type CardInput = {
  personId: string;
  cardKind: 'player' | 'staff';
  programId: string | null;
  seasonId: string | null;
  cardNumber: string;
  validUntil: string;
  photoFileId: string | null;
};

function signedToken(
  orgId: string,
  cardId: string,
  validUntil: string,
  secret: Buffer,
): string {
  const payload = `${orgId}.${cardId}.${validUntil}`;
  const signature = createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');
  return Buffer.from(`${payload}.${signature}`).toString('base64url');
}

function dateOnly(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : value.slice(0, 10);
}

export async function createCard(
  dependencies: CardDependencies,
  context: OrgContext,
  input: CardInput,
) {
  if ((input.programId === null) === (input.seasonId === null))
    throw new CardError(
      400,
      'VALIDATION_ERROR',
      'Choose one program or season for the card',
    );
  return createWithOrg(dependencies.database)(context, async (trx) => {
    const person = await trx
      .selectFrom('people')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('id', '=', input.personId)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!person) throw new CardError(404, 'NOT_FOUND', 'Person not found');
    if (input.programId) {
      const program = await trx
        .selectFrom('programs')
        .select(['id', 'season_id', 'ends_on'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', input.programId)
        .executeTakeFirst();
      if (!program) throw new CardError(404, 'NOT_FOUND', 'Program not found');
      if (
        input.seasonId ||
        input.validUntil > (dateOnly(program.ends_on) ?? '')
      )
        throw new CardError(
          400,
          'VALIDATION_ERROR',
          'Card validity must fit the selected program',
        );
      const participant =
        input.cardKind === 'player'
          ? await trx
              .selectFrom('roster_entries')
              .innerJoin('team_seasons', (join) =>
                join
                  .onRef('team_seasons.org_id', '=', 'roster_entries.org_id')
                  .onRef(
                    'team_seasons.id',
                    '=',
                    'roster_entries.team_season_id',
                  ),
              )
              .select('roster_entries.id')
              .where('roster_entries.org_id', '=', context.orgId)
              .where('roster_entries.person_id', '=', input.personId)
              .where('team_seasons.program_id', '=', input.programId)
              .where('roster_entries.status', 'in', ['active', 'injured'])
              .executeTakeFirst()
          : await trx
              .selectFrom('team_staff')
              .innerJoin('team_seasons', (join) =>
                join
                  .onRef('team_seasons.org_id', '=', 'team_staff.org_id')
                  .onRef('team_seasons.id', '=', 'team_staff.team_season_id'),
              )
              .select('team_staff.id')
              .where('team_staff.org_id', '=', context.orgId)
              .where('team_staff.person_id', '=', input.personId)
              .where('team_seasons.program_id', '=', input.programId)
              .where('team_staff.status', '=', 'active')
              .executeTakeFirst();
      if (!participant)
        throw new CardError(
          409,
          'NOT_CARD_ELIGIBLE',
          'Person is not active in the selected program',
        );
    } else if (input.seasonId) {
      const season = await trx
        .selectFrom('seasons')
        .select(['id', 'ends_on'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', input.seasonId)
        .executeTakeFirst();
      if (!season || input.validUntil > (dateOnly(season.ends_on) ?? ''))
        throw new CardError(
          404,
          'NOT_FOUND',
          'Season not found or card validity exceeds it',
        );
      const participant =
        input.cardKind === 'player'
          ? await trx
              .selectFrom('roster_entries')
              .innerJoin('team_seasons', (join) =>
                join
                  .onRef('team_seasons.org_id', '=', 'roster_entries.org_id')
                  .onRef(
                    'team_seasons.id',
                    '=',
                    'roster_entries.team_season_id',
                  ),
              )
              .innerJoin('programs', (join) =>
                join
                  .onRef('programs.org_id', '=', 'team_seasons.org_id')
                  .onRef('programs.id', '=', 'team_seasons.program_id'),
              )
              .select('roster_entries.id')
              .where('roster_entries.org_id', '=', context.orgId)
              .where('roster_entries.person_id', '=', input.personId)
              .where('programs.season_id', '=', input.seasonId)
              .where('roster_entries.status', 'in', ['active', 'injured'])
              .executeTakeFirst()
          : await trx
              .selectFrom('team_staff')
              .innerJoin('team_seasons', (join) =>
                join
                  .onRef('team_seasons.org_id', '=', 'team_staff.org_id')
                  .onRef('team_seasons.id', '=', 'team_staff.team_season_id'),
              )
              .innerJoin('programs', (join) =>
                join
                  .onRef('programs.org_id', '=', 'team_seasons.org_id')
                  .onRef('programs.id', '=', 'team_seasons.program_id'),
              )
              .select('team_staff.id')
              .where('team_staff.org_id', '=', context.orgId)
              .where('team_staff.person_id', '=', input.personId)
              .where('programs.season_id', '=', input.seasonId)
              .where('team_staff.status', '=', 'active')
              .executeTakeFirst();
      if (!participant)
        throw new CardError(
          409,
          'NOT_CARD_ELIGIBLE',
          'Person is not active in the selected season',
        );
    }
    if (input.photoFileId) {
      const file = await trx
        .selectFrom('files')
        .select(['id', 'purpose', 'sensitivity', 'upload_state', 'deleted_at'])
        .where('org_id', '=', context.orgId)
        .where('id', '=', input.photoFileId)
        .executeTakeFirst();
      if (
        !file ||
        file.purpose !== 'image' ||
        file.upload_state !== 'complete' ||
        file.deleted_at
      )
        throw new CardError(
          400,
          'FILE_INVALID',
          'Choose a completed organization image',
        );
    }
    const id = newId();
    const secret = randomBytes(32);
    await trx
      .insertInto('athlete_cards')
      .values({
        id,
        org_id: context.orgId,
        person_id: input.personId,
        program_id: input.programId,
        season_id: input.seasonId,
        card_kind: input.cardKind,
        card_number: input.cardNumber,
        qr_secret_enc: encryptRestricted(secret, dependencies.encryption),
        photo_file_id: input.photoFileId,
        status: 'active',
        valid_until: input.validUntil,
      })
      .execute();
    await logEligibilityAudit(
      trx,
      context,
      'athlete_card.created',
      'athlete_card',
      id,
      {
        personId: input.personId,
        cardKind: input.cardKind,
        programId: input.programId,
        seasonId: input.seasonId,
        cardNumber: input.cardNumber,
        photoFileId: input.photoFileId,
      },
    );
    const token = signedToken(context.orgId, id, input.validUntil, secret);
    return {
      id,
      cardNumber: input.cardNumber,
      cardKind: input.cardKind,
      validUntil: input.validUntil,
      verificationUrl: `${dependencies.appUrl}/cards/verify/${token}`,
      token,
    };
  });
}

export async function listCards(
  dependencies: CardDependencies,
  context: OrgContext,
  personId: string,
) {
  return createWithOrg(dependencies.database)(context, async (trx) => {
    const link = await trx
      .selectFrom('person_account_links')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('person_id', '=', personId)
      .where('account_id', '=', context.actor.accountId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    const role = await trx
      .selectFrom('role_assignments')
      .select('id')
      .where('org_id', '=', context.orgId)
      .where('account_id', '=', context.actor.accountId)
      .where('role', 'in', ['owner', 'admin', 'compliance'])
      .where('scope_type', '=', 'org')
      .where('revoked_at', 'is', null)
      .where('pending_mfa', '=', false)
      .executeTakeFirst();
    if (!link && !role)
      throw new CardError(404, 'NOT_FOUND', 'Cards not found');
    const rows = await trx
      .selectFrom('athlete_cards')
      .select([
        'id',
        'person_id as personId',
        'program_id as programId',
        'season_id as seasonId',
        'card_kind as cardKind',
        'card_number as cardNumber',
        'photo_file_id as photoFileId',
        'status',
        'valid_until as validUntil',
        'version',
        'qr_secret_enc',
      ])
      .where('org_id', '=', context.orgId)
      .where('person_id', '=', personId)
      .orderBy('created_at', 'desc')
      .execute();
    for (const row of rows) {
      await trx
        .insertInto('audit_log')
        .values({
          id: newId(),
          org_id: context.orgId,
          actor_account_id: context.actor.accountId,
          action: 'restricted.read',
          entity_type: 'athlete_card',
          entity_id: row.id,
          changes: { fields: ['qr_secret_enc'] },
        })
        .execute();
    }
    return rows.map((row) => {
      const validUntil = dateOnly(row.validUntil) ?? '';
      const token = signedToken(
        context.orgId,
        row.id,
        validUntil,
        decryptRestricted(row.qr_secret_enc, dependencies.encryption),
      );
      return {
        id: row.id,
        personId: row.personId,
        programId: row.programId,
        seasonId: row.seasonId,
        cardKind: row.cardKind,
        cardNumber: row.cardNumber,
        photoFileId: row.photoFileId,
        status: row.status,
        validUntil,
        version: row.version,
        token,
        verificationUrl: `${dependencies.appUrl}/cards/verify/${token}`,
      };
    });
  });
}

export async function revokeCard(
  database: Kysely<DB>,
  context: OrgContext,
  cardId: string,
  version: number,
) {
  return createWithOrg(database)(context, async (trx) => {
    const row = await trx
      .updateTable('athlete_cards')
      .set({ status: 'revoked', version: version + 1 })
      .where('org_id', '=', context.orgId)
      .where('id', '=', cardId)
      .where('status', '=', 'active')
      .where('version', '=', version)
      .returning('id')
      .executeTakeFirst();
    if (!row)
      throw new CardError(
        409,
        'CONFLICT',
        'Card changed or has already been revoked',
      );
    await trx
      .insertInto('audit_log')
      .values({
        id: newId(),
        org_id: context.orgId,
        actor_account_id: context.actor.accountId,
        action: 'athlete_card.revoked',
        entity_type: 'athlete_card',
        entity_id: cardId,
        changes: { status: 'revoked' },
      })
      .execute();
    return { id: cardId, status: 'revoked', version: version + 1 };
  });
}

const tokenSchema = z.strictObject({
  orgId: z.uuid(),
  cardId: z.uuid(),
  validUntil: z.iso.date(),
  signature: z.string().min(40).max(80),
});

function parseToken(token: string) {
  try {
    const parts = Buffer.from(token, 'base64url').toString('utf8').split('.');
    return tokenSchema.safeParse({
      orgId: parts[0],
      cardId: parts[1],
      validUntil: parts[2],
      signature: parts[3],
    });
  } catch {
    return {
      success: false as const,
      error: new Error('Invalid verification token'),
    };
  }
}

export async function verifyCard(
  database: Kysely<DB>,
  token: string,
  encryption: EncryptionKeys,
  now = new Date(),
) {
  const parsed = parseToken(token);
  if (!parsed.success) throw new CardError(404, 'NOT_FOUND', 'Card not found');
  const context = {
    orgId: parsed.data.orgId,
    actor: { accountId: parsed.data.orgId },
  };
  const row = await createWithOrg(database)(context, async (trx) => {
    const card = await trx
      .selectFrom('athlete_cards as card')
      .innerJoin('people as person', (join) =>
        join
          .onRef('person.org_id', '=', 'card.org_id')
          .onRef('person.id', '=', 'card.person_id'),
      )
      .innerJoin('organizations', 'organizations.id', 'card.org_id')
      .select([
        'card.id',
        'card.person_id',
        'card.card_kind',
        'card.card_number',
        'card.status',
        'card.valid_until',
        'card.program_id',
        'card.season_id',
        'card.qr_secret_enc',
        'card.photo_file_id',
        'person.first_name',
        'person.last_name',
        'person.status as personStatus',
        'person.media_consent',
        'organizations.timezone',
      ])
      .where('card.org_id', '=', parsed.data.orgId)
      .where('card.id', '=', parsed.data.cardId)
      .executeTakeFirst();
    if (!card) return null;
    await trx
      .insertInto('audit_log')
      .values({
        id: newId(),
        org_id: parsed.data.orgId,
        actor_account_id: null,
        action: 'restricted.read.public_card_verification',
        entity_type: 'athlete_card',
        entity_id: card.id,
        changes: { fields: ['qr_secret_enc'] },
      })
      .execute();
    const validUntil = dateOnly(card.valid_until) ?? '';
    const payload = `${parsed.data.orgId}.${card.id}.${validUntil}`;
    const secret = decryptRestricted(card.qr_secret_enc, encryption);
    const expected = createHmac('sha256', secret).update(payload).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(parsed.data.signature, 'base64url');
    } catch {
      return null;
    }
    if (
      expected.length !== provided.length ||
      !timingSafeEqual(expected, provided)
    )
      return null;
    const today = orgToday(
      card.timezone,
      Temporal.Instant.fromEpochMilliseconds(now.getTime()),
    );
    if (
      card.status !== 'active' ||
      card.personStatus !== 'active' ||
      validUntil !== parsed.data.validUntil ||
      validUntil < today
    )
      return null;
    let teamName: string | null = null;
    if (card.program_id || card.season_id) {
      if (card.card_kind === 'player') {
        const roster = await trx
          .selectFrom('roster_entries')
          .innerJoin('team_seasons', (join) =>
            join
              .onRef('team_seasons.org_id', '=', 'roster_entries.org_id')
              .onRef('team_seasons.id', '=', 'roster_entries.team_season_id'),
          )
          .innerJoin('programs', (join) =>
            join
              .onRef('programs.org_id', '=', 'team_seasons.org_id')
              .onRef('programs.id', '=', 'team_seasons.program_id'),
          )
          .innerJoin('teams', (join) =>
            join
              .onRef('teams.org_id', '=', 'team_seasons.org_id')
              .onRef('teams.id', '=', 'team_seasons.team_id'),
          )
          .select('teams.name')
          .where('roster_entries.org_id', '=', parsed.data.orgId)
          .where('roster_entries.person_id', '=', card.person_id)
          .where('roster_entries.status', 'in', ['active', 'injured'])
          .$if(Boolean(card.program_id), (query) =>
            query.where(
              'team_seasons.program_id',
              '=',
              card.program_id as string,
            ),
          )
          .$if(Boolean(card.season_id), (query) =>
            query.where('programs.season_id', '=', card.season_id as string),
          )
          .executeTakeFirst();
        teamName = roster?.name ?? null;
      } else {
        const staff = await trx
          .selectFrom('team_staff')
          .innerJoin('team_seasons', (join) =>
            join
              .onRef('team_seasons.org_id', '=', 'team_staff.org_id')
              .onRef('team_seasons.id', '=', 'team_staff.team_season_id'),
          )
          .innerJoin('programs', (join) =>
            join
              .onRef('programs.org_id', '=', 'team_seasons.org_id')
              .onRef('programs.id', '=', 'team_seasons.program_id'),
          )
          .innerJoin('teams', (join) =>
            join
              .onRef('teams.org_id', '=', 'team_seasons.org_id')
              .onRef('teams.id', '=', 'team_seasons.team_id'),
          )
          .select('teams.name')
          .where('team_staff.org_id', '=', parsed.data.orgId)
          .where('team_staff.person_id', '=', card.person_id)
          .where('team_staff.status', '=', 'active')
          .$if(Boolean(card.program_id), (query) =>
            query.where(
              'team_seasons.program_id',
              '=',
              card.program_id as string,
            ),
          )
          .$if(Boolean(card.season_id), (query) =>
            query.where('programs.season_id', '=', card.season_id as string),
          )
          .executeTakeFirst();
        teamName = staff?.name ?? null;
      }
    }
    return {
      cardId: card.id,
      cardNumber: card.card_number,
      cardKind: card.card_kind,
      personName: `${card.first_name} ${card.last_name}`,
      teamName,
      validUntil,
      photoAvailable:
        card.media_consent === 'granted' && Boolean(card.photo_file_id),
      photoFileId: card.media_consent === 'granted' ? card.photo_file_id : null,
    };
  });
  if (!row) throw new CardError(404, 'NOT_FOUND', 'Card not found');
  const { photoFileId, ...publicCard } = row;
  return {
    ...publicCard,
    ...(photoFileId
      ? { photoUrl: `/api/v1/compliance/cards/verify/${token}/photo` }
      : {}),
  };
}

export async function readCardPhoto(
  dependencies: CardDependencies,
  token: string,
): Promise<{ mime: string; bytes: Uint8Array }> {
  const verified = await verifyCard(
    dependencies.database,
    token,
    dependencies.encryption,
    dependencies.clock(),
  );
  if (!verified.photoAvailable || !verified.photoUrl)
    throw new CardError(404, 'NOT_FOUND', 'Card photo is unavailable');
  const parts = parseToken(token);
  if (!parts.success)
    throw new CardError(404, 'NOT_FOUND', 'Card photo is unavailable');
  const row = await createWithOrg(dependencies.database)(
    { orgId: parts.data.orgId, actor: { accountId: parts.data.orgId } },
    async (trx) => {
      const card = await trx
        .selectFrom('athlete_cards')
        .select(['person_id', 'photo_file_id'])
        .where('org_id', '=', parts.data.orgId)
        .where('id', '=', parts.data.cardId)
        .executeTakeFirst();
      if (!card?.photo_file_id) return null;
      const person = await trx
        .selectFrom('people')
        .select('media_consent')
        .where('org_id', '=', parts.data.orgId)
        .where('id', '=', card.person_id)
        .executeTakeFirst();
      if (person?.media_consent !== 'granted') return null;
      const file = await trx
        .selectFrom('files')
        .select([
          'id',
          'storage_key',
          'mime',
          'sensitivity',
          'upload_state',
          'deleted_at',
        ])
        .where('org_id', '=', parts.data.orgId)
        .where('id', '=', card.photo_file_id)
        .executeTakeFirst();
      if (!file || file.upload_state !== 'complete' || file.deleted_at)
        return null;
      if (file.sensitivity === 'restricted') {
        await trx
          .insertInto('audit_log')
          .values({
            id: newId(),
            org_id: parts.data.orgId,
            actor_account_id: null,
            action: 'restricted.read.public_card_photo',
            entity_type: 'file',
            entity_id: file.id,
            changes: { access: 'signed_card_verification' },
          })
          .execute();
      }
      return { storageKey: file.storage_key, mime: file.mime };
    },
  );
  if (!row) throw new CardError(404, 'NOT_FOUND', 'Card photo is unavailable');
  const storage =
    dependencies.localStorage ?? new LocalDiskStorage('data/uploads');
  const object = await storage.get(row.storageKey);
  if (!object)
    throw new CardError(404, 'NOT_FOUND', 'Card photo is unavailable');
  return { mime: row.mime, bytes: object.bytes };
}
