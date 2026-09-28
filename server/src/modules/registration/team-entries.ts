import { createHash, randomBytes } from 'node:crypto';

import { newId } from '@shared/ids';
import { sql, type Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '../../db/types.js';
import {
  createWithOrg,
  type OrgContext,
  type OrgTransaction,
} from '../../db/withOrg.js';
import { appendAuditEvent } from '../audit/service.js';

import {
  PostgresRegistrationCheckoutStart,
  RegistrationCheckoutError,
} from './checkout-start.js';
import { requireRegistrationStaff, staffScopeForProgram } from './lifecycle.js';
import { enqueueRegistrationNotice } from './notices.js';

export const createTeamEntrySchema = z.strictObject({
  offeringId: z.uuid(),
  captainPersonId: z.uuid(),
  teamName: z.string().trim().min(2).max(100),
  clubName: z.string().trim().max(100).optional(),
  ageLabel: z.string().trim().max(40).optional(),
  competitionGender: z.enum(['female', 'male', 'open']).optional(),
  seedHint: z.number().int().positive().max(1000).optional(),
});

export const inviteTeamPlayersSchema = z.strictObject({
  emails: z.array(z.email().trim().toLowerCase()).min(1).max(25),
});

export const acceptTeamEntryInviteSchema = z.strictObject({
  personId: z.uuid(),
  householdId: z.uuid(),
});

export const teamEntrySchema = z.strictObject({
  id: z.uuid(),
  teamName: z.string(),
  programId: z.uuid(),
  programName: z.string(),
  divisionId: z.uuid(),
  divisionName: z.string(),
  offeringId: z.uuid(),
  offeringName: z.string(),
  captainPersonId: z.uuid().nullable(),
  status: z.enum([
    'pending_payment',
    'pending_approval',
    'accepted',
    'waitlisted',
    'withdrawn',
    'declined',
  ]),
  seedHint: z.number().int().nullable(),
  createdAt: z.string(),
  inviteCount: z.number().int().nonnegative(),
});

export const teamEntryListSchema = z.strictObject({
  entries: z.array(teamEntrySchema),
});

export const teamEntryOptionsSchema = z.strictObject({
  offerings: z.array(
    z.strictObject({
      offeringId: z.uuid(),
      programName: z.string(),
      divisionName: z.string(),
      offeringName: z.string(),
      requiresApproval: z.boolean(),
    }),
  ),
  captains: z.array(z.strictObject({ personId: z.uuid(), name: z.string() })),
});

export const teamEntryInviteListSchema = z.strictObject({
  invites: z.array(
    z.strictObject({
      id: z.uuid(),
      email: z.email(),
      status: z.enum(['pending', 'accepted', 'expired', 'canceled']),
      expiresAt: z.string(),
    }),
  ),
});

export const teamEntryInvitePreviewSchema = z.strictObject({
  entryId: z.uuid(),
  teamName: z.string(),
  programName: z.string(),
  divisionName: z.string(),
  email: z.email(),
  status: z.enum(['pending', 'accepted', 'expired', 'canceled']),
  expiresAt: z.string(),
});

export const teamEntryInviteCreatedSchema = z.strictObject({
  invites: z.array(
    z.strictObject({
      id: z.uuid(),
      email: z.email(),
      token: z.string(),
      expiresAt: z.string(),
    }),
  ),
});

export const teamEntryDecisionSchema = z.strictObject({
  status: z.enum(['accepted', 'declined']),
});

interface OfferingRow {
  id: string;
  program_id: string;
  program_name: string;
  program_status: string;
  registration_opens_at: Date | null;
  registration_closes_at: Date | null;
  sport_profile_id: string;
  division_id: string;
  division_name: string;
  name: string;
  registrant_role: string;
  price_cents: number;
  capacity: number | null;
  active: boolean;
  visibility: string;
  waitlist_enabled: boolean;
  requires_approval: boolean;
}

interface EntryRow {
  id: string;
  org_id: string;
  program_id: string;
  division_id: string;
  offering_id: string;
  external_team_id: string | null;
  captain_person_id: string | null;
  contact_account_id: string | null;
  status: string;
  seed_hint: number | null;
  created_at: Date;
  team_name: string;
  program_name: string;
  division_name: string;
  offering_name: string;
  invite_count: number;
}

function stableUuid(namespace: string): string {
  const bytes = createHash('sha256').update(namespace).digest().subarray(0, 16);
  if (bytes.length !== 16) throw new Error('UUID digest is incomplete');
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function presentEntry(row: EntryRow) {
  return {
    id: row.id,
    teamName: row.team_name,
    programId: row.program_id,
    programName: row.program_name,
    divisionId: row.division_id,
    divisionName: row.division_name,
    offeringId: row.offering_id,
    offeringName: row.offering_name,
    captainPersonId: row.captain_person_id,
    status: row.status,
    seedHint: row.seed_hint,
    createdAt: row.created_at.toISOString(),
    inviteCount: row.invite_count,
  };
}

/** Captain entry, one-use player invitations and scoped staff decisions. */
export class PostgresTeamEntries {
  private readonly withOrg: ReturnType<typeof createWithOrg>;

  constructor(
    private readonly database: Kysely<DB>,
    private readonly context: OrgContext,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.withOrg = createWithOrg(database);
  }

  async create(input: {
    orgId: string;
    accountId: string;
    idempotencyKey: string;
    details: z.input<typeof createTeamEntrySchema>;
  }): Promise<z.output<typeof teamEntrySchema>> {
    if (
      input.orgId !== this.context.orgId ||
      input.accountId !== this.context.actor.accountId
    )
      throw new RegistrationCheckoutError(
        403,
        'FORBIDDEN',
        'Team entry account context does not match',
      );
    const details = createTeamEntrySchema.parse(input.details);
    const key = z.uuid().parse(input.idempotencyKey);
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({
          ...details,
          teamName: details.teamName.trim(),
          actorAccountId: input.accountId,
        }),
      )
      .digest();
    const entryId = await this.withOrg(this.context, async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${input.orgId}), hashtext(${key}))`.execute(
        trx,
      );
      const replay = await trx
        .selectFrom('team_entries')
        .select(['id', 'creation_hash'])
        .where('org_id', '=', input.orgId)
        .where('creation_key', '=', key)
        .executeTakeFirst();
      if (replay) {
        if (!replay.creation_hash?.equals(requestHash))
          throw new RegistrationCheckoutError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Team entry key was used for a different request',
          );
        return replay.id;
      }
      const offering = await sql<OfferingRow>`
        SELECT o.id, o.program_id, p.name AS program_name, p.status AS program_status,
          p.registration_opens_at, p.registration_closes_at, p.sport_profile_id,
          o.division_id, d.name AS division_name, o.name,
          o.registrant_role, o.price_cents, o.capacity, o.active, o.visibility,
          o.waitlist_enabled, o.requires_approval
        FROM registration_offerings o
        JOIN programs p ON p.org_id = o.org_id AND p.id = o.program_id
        JOIN divisions d ON d.org_id = o.org_id AND d.id = o.division_id
        WHERE o.org_id = ${input.orgId}::uuid AND o.id = ${details.offeringId}::uuid
        FOR UPDATE OF o
      `
        .execute(trx)
        .then((result) => result.rows[0]);
      if (
        !offering ||
        offering.registrant_role !== 'team_entry' ||
        !offering.active ||
        offering.visibility !== 'public' ||
        offering.program_status !== 'registration_open' ||
        (offering.registration_opens_at &&
          offering.registration_opens_at > this.now()) ||
        (offering.registration_closes_at &&
          offering.registration_closes_at <= this.now())
      )
        throw new RegistrationCheckoutError(
          409,
          'INELIGIBLE',
          'This team entry offering is not open',
        );
      if (offering.price_cents !== 0)
        throw new RegistrationCheckoutError(
          409,
          'INELIGIBLE',
          'Team entry fees must be configured as per-player offerings',
        );
      const captain = await sql<{
        first_name: string;
        last_name: string;
        email: string;
        date_of_birth: string;
      }>`
        SELECT person.first_name, person.last_name, account.email,
          person.date_of_birth::text AS date_of_birth
        FROM people person
        JOIN person_account_links link
          ON link.org_id = person.org_id AND link.person_id = person.id
        JOIN accounts account ON account.id = link.account_id
        WHERE person.org_id = ${input.orgId}::uuid
          AND person.id = ${details.captainPersonId}::uuid
          AND account.id = ${input.accountId}::uuid
          AND link.relationship = 'self' AND link.verified_at IS NOT NULL
          AND link.revoked_at IS NULL AND account.email_verified_at IS NOT NULL
          AND person.date_of_birth <= current_date - interval '18 years'
      `
        .execute(trx)
        .then((result) => result.rows[0]);
      if (!captain)
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'A verified adult participant is required to captain a team',
        );

      const requiresApproval = offering.requires_approval;
      const status = requiresApproval ? 'pending_approval' : 'accepted';
      const counters: Array<{
        subject: 'program' | 'division' | 'offering';
        id: string;
        capacity: number | null;
      }> = [];
      for (const [subject, id, fallbackCapacity] of [
        ['program', offering.program_id, null],
        ['division', offering.division_id, null],
        ['offering', offering.id, offering.capacity],
      ] as const) {
        const counter = await trx
          .selectFrom('capacity_counters')
          .select(['capacity', 'confirmed', 'held'])
          .where('org_id', '=', input.orgId)
          .where('subject_type', '=', subject)
          .where('subject_id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (!counter)
          throw new RegistrationCheckoutError(
            503,
            'CAPACITY_UNAVAILABLE',
            'Team entry capacity is not configured',
          );
        const capacity = counter.capacity ?? fallbackCapacity;
        if (capacity !== null && counter.confirmed + counter.held >= capacity)
          throw new RegistrationCheckoutError(
            409,
            'CAPACITY_FULL',
            'No team entry places remain',
          );
        counters.push({ subject, id, capacity });
      }

      const externalTeamId = newId();
      await trx
        .insertInto('external_teams')
        .values({
          id: externalTeamId,
          org_id: input.orgId,
          name: details.teamName.trim(),
          club_name: details.clubName?.trim() || null,
          contact_name: `${captain.first_name} ${captain.last_name}`,
          contact_email: captain.email,
          sport_profile_id: offering.sport_profile_id,
          age_label: details.ageLabel?.trim() || null,
          competition_gender: details.competitionGender ?? null,
        })
        .execute();
      const id = newId();
      await trx
        .insertInto('team_entries')
        .values({
          id,
          org_id: input.orgId,
          program_id: offering.program_id,
          division_id: offering.division_id,
          offering_id: offering.id,
          external_team_id: externalTeamId,
          entrant_org_id: null,
          captain_person_id: details.captainPersonId,
          contact_account_id: input.accountId,
          status,
          seed_hint: details.seedHint ?? null,
          invoice_id: null,
          creation_key: key,
          creation_hash: requestHash,
        })
        .execute();
      for (const counter of counters) {
        await trx
          .updateTable('capacity_counters')
          .set({
            ...(requiresApproval
              ? { held: sql`held + 1` }
              : { confirmed: sql`confirmed + 1` }),
            version: sql`version + 1`,
          })
          .where('org_id', '=', input.orgId)
          .where('subject_type', '=', counter.subject)
          .where('subject_id', '=', counter.id)
          .execute();
      }
      await appendAuditEvent(trx, this.context, {
        action: 'team_entry.created',
        entityType: 'team_entry',
        entityId: id,
        changes: {
          status: { tier: 'internal', after: status },
          teamName: { tier: 'internal', after: details.teamName.trim() },
        },
      });
      return id;
    });
    const row = await this.readEntry(input.orgId, entryId);
    return teamEntrySchema.parse(row);
  }

  async options(
    orgId: string,
  ): Promise<z.output<typeof teamEntryOptionsSchema>> {
    return this.withOrg(this.context, async (trx) => {
      const offerings = await sql<{
        offering_id: string;
        program_name: string;
        division_name: string;
        offering_name: string;
        requires_approval: boolean;
      }>`
        SELECT o.id AS offering_id, p.name AS program_name,
          d.name AS division_name, o.name AS offering_name,
          o.requires_approval
        FROM registration_offerings o
        JOIN programs p ON p.org_id = o.org_id AND p.id = o.program_id
        JOIN divisions d ON d.org_id = o.org_id AND d.id = o.division_id
        WHERE o.org_id = ${orgId}::uuid AND o.registrant_role = 'team_entry'
          AND o.active AND o.visibility = 'public' AND o.price_cents = 0
          AND p.status = 'registration_open'
          AND (p.registration_opens_at IS NULL OR p.registration_opens_at <= now())
          AND (p.registration_closes_at IS NULL OR p.registration_closes_at > now())
        ORDER BY p.name, d.name, o.sort_order, o.name
      `.execute(trx);
      const captains = await sql<{
        person_id: string;
        name: string;
      }>`
        SELECT person.id AS person_id,
          person.first_name || ' ' || person.last_name AS name
        FROM people person
        JOIN person_account_links link
          ON link.org_id = person.org_id AND link.person_id = person.id
        JOIN accounts account ON account.id = link.account_id
        WHERE person.org_id = ${orgId}::uuid
          AND account.id = ${this.context.actor.accountId}::uuid
          AND account.email_verified_at IS NOT NULL
          AND person.date_of_birth <= current_date - interval '18 years'
          AND link.relationship = 'self' AND link.verified_at IS NOT NULL
          AND link.revoked_at IS NULL
        ORDER BY person.first_name, person.last_name
      `.execute(trx);
      return teamEntryOptionsSchema.parse({
        offerings: offerings.rows.map((row) => ({
          offeringId: row.offering_id,
          programName: row.program_name,
          divisionName: row.division_name,
          offeringName: row.offering_name,
          requiresApproval: row.requires_approval,
        })),
        captains: captains.rows.map((row) => ({
          personId: row.person_id,
          name: row.name,
        })),
      });
    });
  }

  async listMine(orgId: string): Promise<z.output<typeof teamEntryListSchema>> {
    return teamEntryListSchema.parse({
      entries: await this.withOrg(this.context, async (trx) => {
        const result = await this.entryQuery(trx)
          .where('te.org_id', '=', orgId)
          .where('te.contact_account_id', '=', this.context.actor.accountId)
          .orderBy('te.created_at', 'desc')
          .limit(100)
          .execute();
        return result.map(presentEntry);
      }),
    });
  }

  async listStaff(
    orgId: string,
  ): Promise<z.output<typeof teamEntryListSchema>> {
    return teamEntryListSchema.parse({
      entries: await this.withOrg(this.context, async (trx) => {
        const result = await this.entryQuery(trx)
          .orderBy('te.created_at', 'desc')
          .limit(200)
          .execute();
        const scoped = [];
        for (const entry of result) {
          const scope = await staffScopeForProgram(
            trx,
            orgId,
            entry.program_id,
            entry.division_id,
          );
          try {
            await requireRegistrationStaff(trx, this.context, scope);
            scoped.push(presentEntry(entry));
          } catch (error) {
            if (
              !(error instanceof RegistrationCheckoutError) ||
              error.status !== 403
            )
              throw error;
          }
        }
        return scoped;
      }),
    });
  }

  async listInvites(
    orgId: string,
    entryId: string,
  ): Promise<z.output<typeof teamEntryInviteListSchema>> {
    return this.withOrg(this.context, async (trx) => {
      const entry = await trx
        .selectFrom('team_entries')
        .select(['contact_account_id', 'program_id', 'division_id'])
        .where('org_id', '=', orgId)
        .where('id', '=', entryId)
        .executeTakeFirst();
      if (!entry)
        throw new RegistrationCheckoutError(
          404,
          'NOT_FOUND',
          'Team entry not found',
        );
      if (entry.contact_account_id !== this.context.actor.accountId)
        await requireRegistrationStaff(
          trx,
          this.context,
          await staffScopeForProgram(
            trx,
            orgId,
            entry.program_id,
            entry.division_id,
          ),
        );
      const invites = await trx
        .selectFrom('team_entry_invites')
        .select(['id', 'email', 'status', 'expires_at'])
        .where('org_id', '=', orgId)
        .where('team_entry_id', '=', entryId)
        .orderBy('created_at')
        .execute();
      return teamEntryInviteListSchema.parse({
        invites: invites.map((invite) => ({
          id: invite.id,
          email: invite.email,
          status: invite.status,
          expiresAt: invite.expires_at.toISOString(),
        })),
      });
    });
  }

  async invitePlayers(
    orgId: string,
    entryId: string,
    input: z.input<typeof inviteTeamPlayersSchema>,
  ): Promise<z.output<typeof teamEntryInviteCreatedSchema>> {
    const emails = inviteTeamPlayersSchema.parse(input).emails;
    if (new Set(emails).size !== emails.length)
      throw new RegistrationCheckoutError(
        400,
        'INELIGIBLE',
        'Each player email may appear only once',
      );
    return this.withOrg(this.context, async (trx) => {
      const entry = await trx
        .selectFrom('team_entries')
        .select([
          'id',
          'contact_account_id',
          'program_id',
          'division_id',
          'status',
        ])
        .where('org_id', '=', orgId)
        .where('id', '=', entryId)
        .forUpdate()
        .executeTakeFirst();
      if (!entry)
        throw new RegistrationCheckoutError(
          404,
          'NOT_FOUND',
          'Team entry not found',
        );
      if (
        entry.contact_account_id !== this.context.actor.accountId ||
        !['pending_approval', 'accepted'].includes(entry.status)
      )
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'Only the captain may invite players to this team',
        );
      const result: Array<{
        id: string;
        email: string;
        token: string;
        expiresAt: string;
      }> = [];
      for (const email of emails) {
        const existing = await trx
          .selectFrom('team_entry_invites')
          .select('id')
          .where('org_id', '=', orgId)
          .where('team_entry_id', '=', entryId)
          .where('email', '=', email)
          .executeTakeFirst();
        if (existing)
          throw new RegistrationCheckoutError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This email has already been invited to the team',
          );
        const token = randomBytes(32).toString('base64url');
        const id = newId();
        const expiresAt = new Date(this.now().getTime() + 7 * 24 * 60 * 60_000);
        await trx
          .insertInto('team_entry_invites')
          .values({
            id,
            org_id: orgId,
            team_entry_id: entryId,
            email,
            token_hash: createHash('sha256').update(token).digest(),
            status: 'pending',
            expires_at: expiresAt,
            invited_by: this.context.actor.accountId,
            person_id: null,
            accepted_registration_id: null,
            checkout_id: null,
          })
          .execute();
        const account = await trx
          .selectFrom('accounts')
          .select(['id', 'email_verified_at', 'status'])
          .where('email', '=', email)
          .executeTakeFirst();
        if (account?.email_verified_at && account.status === 'active')
          await enqueueRegistrationNotice(trx, this.context, {
            kind: 'team_entry_invite',
            sourceId: id,
            accountId: account.id,
            payload: { token },
          });
        result.push({ id, email, token, expiresAt: expiresAt.toISOString() });
      }
      await appendAuditEvent(trx, this.context, {
        action: 'team_entry.players_invited',
        entityType: 'team_entry',
        entityId: entryId,
        changes: {
          inviteCount: { tier: 'internal', after: result.length },
        },
      });
      return teamEntryInviteCreatedSchema.parse({ invites: result });
    });
  }

  async previewInvite(
    orgId: string,
    token: string,
  ): Promise<z.output<typeof teamEntryInvitePreviewSchema>> {
    const tokenHash = this.tokenHash(token);
    return this.withOrg(this.context, async (trx) => {
      const invite = await sql<{
        id: string;
        entry_id: string;
        email: string;
        status: string;
        expires_at: Date;
        team_name: string;
        program_name: string;
        division_name: string;
        account_email: string;
        email_verified_at: Date | null;
      }>`
        SELECT i.id, i.team_entry_id AS entry_id, i.email, i.status,
          i.expires_at, team.name AS team_name, p.name AS program_name,
          d.name AS division_name, account.email AS account_email,
          account.email_verified_at
        FROM team_entry_invites i
        JOIN team_entries te ON te.org_id = i.org_id AND te.id = i.team_entry_id
        JOIN external_teams team ON team.org_id = te.org_id AND team.id = te.external_team_id
        JOIN programs p ON p.org_id = te.org_id AND p.id = te.program_id
        JOIN divisions d ON d.org_id = te.org_id AND d.id = te.division_id
        JOIN accounts account ON account.id = ${this.context.actor.accountId}::uuid
        WHERE i.org_id = ${orgId}::uuid AND i.token_hash = ${tokenHash}
        FOR UPDATE OF i
      `
        .execute(trx)
        .then((result) => result.rows[0]);
      if (!invite)
        throw new RegistrationCheckoutError(
          404,
          'TEAM_ENTRY_UNAVAILABLE',
          'Team invitation is unavailable',
        );
      if (
        invite.email.toLowerCase() !== invite.account_email.toLowerCase() ||
        !invite.email_verified_at
      )
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'Sign in with the verified account invited to this team',
        );
      if (invite.status === 'pending' && invite.expires_at <= this.now()) {
        await trx
          .updateTable('team_entry_invites')
          .set({ status: 'expired' })
          .where('org_id', '=', orgId)
          .where('id', '=', invite.id)
          .execute();
        invite.status = 'expired';
      }
      return teamEntryInvitePreviewSchema.parse({
        entryId: invite.entry_id,
        teamName: invite.team_name,
        programName: invite.program_name,
        divisionName: invite.division_name,
        email: invite.email,
        status: invite.status,
        expiresAt: invite.expires_at.toISOString(),
      });
    });
  }

  async acceptInvite(input: {
    orgId: string;
    token: string;
    details: z.input<typeof acceptTeamEntryInviteSchema>;
  }): Promise<{ checkoutId: string }> {
    const details = acceptTeamEntryInviteSchema.parse(input.details);
    const tokenHash = this.tokenHash(input.token);
    const invite = await this.withOrg(this.context, async (trx) => {
      const result = await sql<{
        id: string;
        email: string;
        status: string;
        expires_at: Date;
        person_id: string | null;
        checkout_id: string | null;
        program_id: string;
        division_id: string;
        account_email: string;
        email_verified_at: Date | null;
      }>`
        SELECT i.id, i.email, i.status, i.expires_at, i.person_id, i.checkout_id,
          te.program_id, te.division_id, account.email AS account_email,
          account.email_verified_at
        FROM team_entry_invites i
        JOIN team_entries te ON te.org_id = i.org_id AND te.id = i.team_entry_id
        JOIN accounts account ON account.id = ${this.context.actor.accountId}::uuid
        WHERE i.org_id = ${input.orgId}::uuid AND i.token_hash = ${tokenHash}
        FOR UPDATE OF i
      `.execute(trx);
      const row = result.rows[0];
      if (
        !row ||
        row.email.toLowerCase() !== row.account_email.toLowerCase() ||
        !row.email_verified_at
      )
        throw new RegistrationCheckoutError(
          403,
          'FORBIDDEN',
          'The verified account invited to this team must accept',
        );
      if (row.status === 'accepted' && row.checkout_id) {
        if (row.person_id !== details.personId)
          throw new RegistrationCheckoutError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'This team invitation was accepted for another participant',
          );
        return row;
      }
      if (row.status !== 'pending' || row.expires_at <= this.now())
        throw new RegistrationCheckoutError(
          409,
          'TEAM_ENTRY_UNAVAILABLE',
          'Team invitation is no longer available',
        );
      if (row.person_id && row.person_id !== details.personId)
        throw new RegistrationCheckoutError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'This invitation is already being accepted for another participant',
        );
      if (!row.person_id) {
        await trx
          .updateTable('team_entry_invites')
          .set({ person_id: details.personId })
          .where('org_id', '=', input.orgId)
          .where('id', '=', row.id)
          .where('status', '=', 'pending')
          .where('person_id', 'is', null)
          .execute();
        row.person_id = details.personId;
      }
      return row;
    });
    if (invite.status === 'accepted' && invite.checkout_id)
      return { checkoutId: invite.checkout_id };

    const offering = await this.withOrg(this.context, async (trx) =>
      trx
        .selectFrom('registration_offerings')
        .select('id')
        .where('org_id', '=', input.orgId)
        .where('program_id', '=', invite.program_id)
        .where((eb) =>
          eb.or([
            eb('division_id', '=', invite.division_id),
            eb('division_id', 'is', null),
          ]),
        )
        .where('registrant_role', '=', 'athlete')
        .where('active', '=', true)
        .where('visibility', '=', 'public')
        .orderBy(
          sql<number>`CASE WHEN division_id = ${invite.division_id}::uuid THEN 0 ELSE 1 END`,
        )
        .orderBy('sort_order')
        .executeTakeFirst(),
    );
    if (!offering)
      throw new RegistrationCheckoutError(
        409,
        'INELIGIBLE',
        'This program has no player registration offering for the team invite',
      );
    const checkout = await new PostgresRegistrationCheckoutStart(
      this.database,
      this.context,
      this.now,
    ).start({
      orgId: input.orgId,
      creationKey: stableUuid(`team-entry-invite:${invite.id}`),
      cart: {
        offerings: [
          {
            lineId: stableUuid(`team-entry-invite-line:${invite.id}`),
            offeringId: offering.id,
            personId: details.personId,
            householdId: details.householdId,
          },
        ],
      },
    });
    return this.withOrg(this.context, async (trx) => {
      const updated = await trx
        .updateTable('team_entry_invites')
        .set({
          status: 'accepted',
          person_id: details.personId,
          checkout_id: checkout.checkoutId,
        })
        .where('org_id', '=', input.orgId)
        .where('id', '=', invite.id)
        .where('status', '=', 'pending')
        .execute();
      if (Number(updated[0]?.numUpdatedRows ?? 0) === 0) {
        const replay = await trx
          .selectFrom('team_entry_invites')
          .select(['person_id', 'checkout_id', 'status'])
          .where('org_id', '=', input.orgId)
          .where('id', '=', invite.id)
          .executeTakeFirst();
        if (
          replay?.status === 'accepted' &&
          replay.person_id === details.personId &&
          replay.checkout_id === checkout.checkoutId
        )
          return { checkoutId: replay.checkout_id };
        throw new RegistrationCheckoutError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'This invitation was accepted by another request',
        );
      }
      await appendAuditEvent(trx, this.context, {
        action: 'team_entry.invite_accepted',
        entityType: 'team_entry_invite',
        entityId: invite.id,
        changes: {
          checkoutId: { tier: 'internal', after: checkout.checkoutId },
        },
      });
      return { checkoutId: checkout.checkoutId };
    });
  }

  async decide(
    orgId: string,
    entryId: string,
    decision: 'approved' | 'declined',
    note?: string,
  ): Promise<z.output<typeof teamEntryDecisionSchema>> {
    return this.withOrg(this.context, async (trx) => {
      const entry = await trx
        .selectFrom('team_entries')
        .select([
          'id',
          'program_id',
          'division_id',
          'offering_id',
          'contact_account_id',
          'external_team_id',
          'status',
        ])
        .where('org_id', '=', orgId)
        .where('id', '=', entryId)
        .forUpdate()
        .executeTakeFirst();
      if (!entry)
        throw new RegistrationCheckoutError(
          404,
          'NOT_FOUND',
          'Team entry not found',
        );
      await requireRegistrationStaff(
        trx,
        this.context,
        await staffScopeForProgram(
          trx,
          orgId,
          entry.program_id,
          entry.division_id,
        ),
      );
      if (entry.status !== 'pending_approval')
        throw new RegistrationCheckoutError(
          409,
          'DECISION_ALREADY_RECORDED',
          'Team entry is not awaiting approval',
        );
      if (decision === 'declined') {
        const startedPlayerCheckout = await trx
          .selectFrom('team_entry_invites')
          .select('id')
          .where('org_id', '=', orgId)
          .where('team_entry_id', '=', entryId)
          .where((eb) =>
            eb.or([
              eb('status', '=', 'accepted'),
              eb('checkout_id', 'is not', null),
            ]),
          )
          .executeTakeFirst();
        if (startedPlayerCheckout)
          throw new RegistrationCheckoutError(
            409,
            'TEAM_ENTRY_UNAVAILABLE',
            'A player has started registration; resolve player checkouts before declining this team',
          );
      }
      const nextStatus = decision === 'approved' ? 'accepted' : 'declined';
      if (!entry.external_team_id)
        throw new RegistrationCheckoutError(
          409,
          'TEAM_ENTRY_UNAVAILABLE',
          'Only external team entries can be decided through this workflow',
        );
      const team = await trx
        .selectFrom('external_teams')
        .select('name')
        .where('org_id', '=', orgId)
        .where('id', '=', entry.external_team_id)
        .executeTakeFirstOrThrow();
      for (const [subject, id] of [
        ['program', entry.program_id],
        ['division', entry.division_id],
        ['offering', entry.offering_id],
      ] as const) {
        const counterChange = await trx
          .updateTable('capacity_counters')
          .set({
            held: sql`held - 1`,
            ...(decision === 'approved'
              ? { confirmed: sql`confirmed + 1` }
              : {}),
            version: sql`version + 1`,
          })
          .where('org_id', '=', orgId)
          .where('subject_type', '=', subject)
          .where('subject_id', '=', id)
          .where('held', '>', 0)
          .executeTakeFirst();
        if (Number(counterChange.numUpdatedRows) !== 1)
          throw new RegistrationCheckoutError(
            500,
            'CAPACITY_UNAVAILABLE',
            'Team entry capacity reservation does not reconcile',
          );
      }
      await trx
        .updateTable('team_entries')
        .set({ status: nextStatus, version: sql`version + 1` })
        .where('org_id', '=', orgId)
        .where('id', '=', entryId)
        .execute();
      if (decision === 'declined')
        await trx
          .updateTable('team_entry_invites')
          .set({ status: 'canceled' })
          .where('org_id', '=', orgId)
          .where('team_entry_id', '=', entryId)
          .where('status', '=', 'pending')
          .execute();
      const invitedAccounts = await sql<{
        invite_id: string;
        account_id: string;
      }>`
        SELECT i.id AS invite_id, a.id AS account_id
        FROM team_entry_invites i
        JOIN accounts a ON lower(a.email) = lower(i.email)
        WHERE i.org_id = ${orgId}::uuid
          AND i.team_entry_id = ${entryId}::uuid
          AND i.status IN ('pending', 'accepted', 'canceled')
          AND a.email_verified_at IS NOT NULL AND a.status = 'active'
      `.execute(trx);
      if (entry.contact_account_id) {
        await enqueueRegistrationNotice(trx, this.context, {
          kind: 'team_entry_status',
          sourceId: entryId,
          accountId: entry.contact_account_id,
          payload: { status: nextStatus, teamName: team.name },
        });
      }
      for (const invited of invitedAccounts.rows) {
        await enqueueRegistrationNotice(trx, this.context, {
          kind: 'team_entry_status',
          sourceId: invited.invite_id,
          accountId: invited.account_id,
          payload: { status: nextStatus, teamName: team.name },
        });
      }
      await appendAuditEvent(trx, this.context, {
        action: `team_entry.${decision}`,
        entityType: 'team_entry',
        entityId: entryId,
        changes: {
          status: { tier: 'internal', before: entry.status, after: nextStatus },
          note: { tier: 'internal', after: note?.trim() || null },
        },
      });
      return teamEntryDecisionSchema.parse({ status: nextStatus });
    });
  }

  private entryQuery(trx: OrgTransaction) {
    return trx
      .selectFrom('team_entries as te')
      .innerJoin('external_teams as team', (join) =>
        join
          .onRef('team.org_id', '=', 'te.org_id')
          .onRef('team.id', '=', 'te.external_team_id'),
      )
      .innerJoin('programs as p', (join) =>
        join
          .onRef('p.org_id', '=', 'te.org_id')
          .onRef('p.id', '=', 'te.program_id'),
      )
      .innerJoin('divisions as d', (join) =>
        join
          .onRef('d.org_id', '=', 'te.org_id')
          .onRef('d.id', '=', 'te.division_id'),
      )
      .innerJoin('registration_offerings as o', (join) =>
        join
          .onRef('o.org_id', '=', 'te.org_id')
          .onRef('o.id', '=', 'te.offering_id'),
      )
      .select([
        'te.id',
        'te.org_id',
        'te.program_id',
        'te.division_id',
        'te.offering_id',
        'te.external_team_id',
        'te.captain_person_id',
        'te.contact_account_id',
        'te.status',
        'te.seed_hint',
        'te.created_at',
        'team.name as team_name',
        'p.name as program_name',
        'd.name as division_name',
        'o.name as offering_name',
        sql<number>`(SELECT count(*)::integer FROM team_entry_invites i
          WHERE i.org_id = te.org_id AND i.team_entry_id = te.id
            AND i.status IN ('pending', 'accepted'))`.as('invite_count'),
      ])
      .where('te.org_id', '=', this.context.orgId);
  }

  private async readEntry(orgId: string, entryId: string) {
    return this.withOrg(this.context, (trx) =>
      this.entryQuery(trx)
        .where('te.org_id', '=', orgId)
        .where('te.id', '=', entryId)
        .executeTakeFirstOrThrow()
        .then(presentEntry),
    );
  }

  private tokenHash(token: string): Buffer {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new RegistrationCheckoutError(
        404,
        'TEAM_ENTRY_UNAVAILABLE',
        'Team invitation is unavailable',
      );
    return createHash('sha256').update(token).digest();
  }
}
