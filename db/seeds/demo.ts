import { createHash } from 'node:crypto';

import { builtInSportTemplates } from '@shared/sport/templates';
import { sql } from 'kysely';
import type { Insertable, Kysely, RawBuilder } from 'kysely';

import type { DB } from '../../server/src/db/types';
import { createWithOrg } from '../../server/src/db/withOrg';
import type { OrgContext, OrgTransaction } from '../../server/src/db/withOrg';
import { hashPassword } from '../../server/src/modules/auth/password';
import {
  acceptRelationship,
  createRelationship,
  listRelationships,
} from '../../server/src/modules/federation/relationships';
import { PostgresInvoiceRepository } from '../../server/src/modules/finance/invoice-repo';

function stableId(seed: string): string {
  const digest = createHash('sha256').update(seed).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-7${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function valueAt<T>(values: readonly T[], index: number, label: string): T {
  const value = values[index];
  if (value === undefined)
    throw new Error(`Missing ${label} at index ${String(index)}`);
  return value;
}

function requiredValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}`);
  return value;
}

const FIRST = [
  'Avery',
  'Jordan',
  'Riley',
  'Casey',
  'Morgan',
  'Quinn',
  'Taylor',
  'Rowan',
  'Parker',
  'Skyler',
  'Reese',
  'Finley',
];
const LAST = [
  'Reyes',
  'Nguyen',
  'Okafor',
  'Larsen',
  'Delgado',
  'Kim',
  'Patel',
  'Morales',
  'Fischer',
  'Torres',
  'Webb',
  'Sullivan',
];
const SEED_TIME = new Date('2025-01-01T12:00:00.000Z');
const LOAD_ORG_COUNT = 100;
const LOAD_REGISTRATIONS_PER_PROGRAM = 1000;
const LOAD_ATTENDANCE_EVENTS_PER_ORG = 20;
const LOAD_ATTENDANCE_PEOPLE_PER_EVENT = 1000;
const LOAD_FAMILY_ACCOUNTS = 20_000;
const LOAD_COACH_ACCOUNTS = 500;

function loadUuid(seed: RawBuilder<unknown>): RawBuilder<string> {
  const digest = sql`md5(${seed})`;
  return sql<string>`(
    substr(${digest}, 1, 8) || '-' ||
    substr(${digest}, 9, 4) || '-7' ||
    substr(${digest}, 14, 3) || '-8' ||
    substr(${digest}, 18, 3) || '-' ||
    substr(${digest}, 21, 12)
  )::uuid`;
}

interface ProgramSpec {
  name: string;
  mode: 'league' | 'club' | 'class' | 'tryout' | 'tournament';
  sportKey: string;
  priceCents: number;
  divisions: string[];
  teamEntryPriceCents?: number;
}

interface OrgSpec {
  seed: string;
  slug: string;
  name: string;
  kind: string;
  timezone: string;
  city: string;
  state: string;
  sports: string[];
  facilityNames: string[];
  facilityKind: 'field' | 'court' | 'pool' | 'mat' | 'track';
  programs: ProgramSpec[];
  teamCount: number;
  households: number;
  adultMembers?: boolean;
  externalTeams?: string[];
  memberClubSeeds?: string[];
  officialCount?: number;
  closure?: boolean;
}

const ORGS: OrgSpec[] = [
  {
    seed: 'riverside',
    slug: 'riverside-rec-soccer',
    name: 'Riverside Rec Soccer League',
    kind: 'league',
    timezone: 'America/Chicago',
    city: 'Naperville',
    state: 'IL',
    sports: ['soccer'],
    facilityNames: [
      'Riverside Field 1',
      'Riverside Field 2',
      'Riverside Field 3',
      'Riverside Field 4',
      'Riverside Field 5',
      'Riverside Field 6',
      'Riverside Field 7',
      'Riverside Field 8',
    ],
    facilityKind: 'field',
    teamCount: 45,
    households: 600,
    closure: true,
    programs: [
      {
        name: 'Fall Recreational Soccer',
        mode: 'league',
        sportKey: 'soccer',
        priceCents: 14500,
        divisions: ['U6', 'U7', 'U8', 'U9', 'U10', 'U11', 'U12', 'U13', 'U14'],
      },
    ],
  },
  {
    seed: 'summit',
    slug: 'summit-volleyball-club',
    name: 'Summit Volleyball Club',
    kind: 'club',
    timezone: 'America/Denver',
    city: 'Boulder',
    state: 'CO',
    sports: ['volleyball'],
    facilityNames: ['Summit Fieldhouse Court A', 'Summit Fieldhouse Court B'],
    facilityKind: 'court',
    teamCount: 24,
    households: 96,
    programs: [
      {
        name: '2026 Club Season and Team Fees',
        mode: 'club',
        sportKey: 'volleyball',
        priceCents: 185000,
        teamEntryPriceCents: 250000,
        divisions: ['14U', '15U', '16U', '17U', '18U'],
      },
      {
        name: '2026 Volleyball Tryouts',
        mode: 'tryout',
        sportKey: 'volleyball',
        priceCents: 4500,
        divisions: ['14U', '15U', '16U', '17U', '18U'],
      },
      {
        name: 'Summit Invitational Tournament',
        mode: 'tournament',
        sportKey: 'volleyball',
        priceCents: 0,
        divisions: ['14U', '16U', '18U'],
      },
    ],
  },
  {
    seed: 'northstar',
    slug: 'northstar-gymnastics-swim',
    name: 'Northstar Gymnastics & Swim Academy',
    kind: 'academy',
    timezone: 'America/Minneapolis',
    city: 'Minneapolis',
    state: 'MN',
    sports: ['gymnastics', 'swimming'],
    facilityNames: ['Northstar Gymnastics Center', 'Northstar Aquatic Center'],
    facilityKind: 'mat',
    teamCount: 0,
    households: 300,
    programs: Array.from({ length: 40 }, (_, index) => ({
      name: `${index % 2 === 0 ? 'Gymnastics' : 'Swim'} Level ${String(Math.floor(index / 4) + 1)} Class ${String(index + 1).padStart(2, '0')}`,
      mode: 'class' as const,
      sportKey: index % 2 === 0 ? 'gymnastics' : 'swimming',
      priceCents: 9600,
      divisions: ['Beginner', 'Intermediate', 'Advanced'],
    })),
  },
  {
    seed: 'metro-north-club',
    slug: 'riverbend-sc',
    name: 'Riverbend Soccer Club',
    kind: 'club',
    timezone: 'America/Chicago',
    city: 'Joliet',
    state: 'IL',
    sports: ['soccer'],
    facilityNames: ['Riverbend Field 1'],
    facilityKind: 'field',
    teamCount: 2,
    households: 20,
    programs: [
      {
        name: 'Riverbend U12 Club',
        mode: 'club',
        sportKey: 'soccer',
        priceCents: 0,
        divisions: ['U12'],
      },
    ],
  },
  {
    seed: 'metro-south-club',
    slug: 'harbor-city-fc',
    name: 'Harbor City FC',
    kind: 'club',
    timezone: 'America/Chicago',
    city: 'Aurora',
    state: 'IL',
    sports: ['soccer'],
    facilityNames: ['Harbor City Field 1'],
    facilityKind: 'field',
    teamCount: 2,
    households: 20,
    programs: [
      {
        name: 'Harbor City U12 Club',
        mode: 'club',
        sportKey: 'soccer',
        priceCents: 0,
        divisions: ['U12'],
      },
    ],
  },
  {
    seed: 'metro',
    slug: 'metro-youth-sports-association',
    name: 'Metro Youth Sports Association',
    kind: 'association',
    timezone: 'America/Chicago',
    city: 'Chicago',
    state: 'IL',
    sports: ['soccer', 'basketball'],
    facilityNames: ['Metro North Field', 'Metro South Gym'],
    facilityKind: 'field',
    teamCount: 8,
    households: 40,
    officialCount: 8,
    externalTeams: ['Riverbend SC U12', 'Harbor City FC U12'],
    memberClubSeeds: ['metro-north-club', 'metro-south-club'],
    programs: [
      {
        name: 'Metro Inter-Club League',
        mode: 'league',
        sportKey: 'soccer',
        priceCents: 0,
        teamEntryPriceCents: 0,
        divisions: ['U12', 'U14'],
      },
    ],
  },
  {
    seed: 'lakeside',
    slug: 'lakeside-wrestling-track',
    name: 'Lakeside Wrestling & Track',
    kind: 'club',
    timezone: 'America/Detroit',
    city: 'Ann Arbor',
    state: 'MI',
    sports: ['wrestling', 'track_field'],
    facilityNames: ['Lakeside Fieldhouse', 'Lakeside Track'],
    facilityKind: 'mat',
    teamCount: 8,
    households: 48,
    programs: [
      {
        name: 'Lakeside Wrestling Duals',
        mode: 'league',
        sportKey: 'wrestling',
        priceCents: 6500,
        divisions: ['Youth', 'Middle School', 'High School'],
      },
      {
        name: 'Lakeside Track Meets',
        mode: 'tournament',
        sportKey: 'track_field',
        priceCents: 6500,
        divisions: ['Youth', 'Middle School', 'High School'],
      },
    ],
  },
  {
    seed: 'cityside',
    slug: 'cityside-adult-rec',
    name: 'Cityside Adult Pickleball & Softball',
    kind: 'league',
    timezone: 'America/Los_Angeles',
    city: 'Portland',
    state: 'OR',
    sports: ['pickleball', 'softball'],
    facilityNames: ['Cityside Pickleball Courts', 'Cityside Softball Diamond'],
    facilityKind: 'court',
    teamCount: 8,
    households: 32,
    adultMembers: true,
    programs: [
      {
        name: 'Adult Pickleball Rec League',
        mode: 'league',
        sportKey: 'pickleball',
        priceCents: 5500,
        teamEntryPriceCents: 9000,
        divisions: ['Recreational', 'Competitive'],
      },
      {
        name: 'Adult Softball Rec League',
        mode: 'league',
        sportKey: 'softball',
        priceCents: 7500,
        teamEntryPriceCents: 12500,
        divisions: ['Coed', 'Open'],
      },
    ],
  },
];

function template(key: string) {
  const found = builtInSportTemplates.find((item) => item.key === key);
  if (!found) throw new Error(`Missing sport template ${key}`);
  return found;
}

function personName(index: number): { first: string; last: string } {
  return {
    first: valueAt(FIRST, index % FIRST.length, 'first name'),
    last: valueAt(LAST, Math.floor(index / 2) % LAST.length, 'last name'),
  };
}

async function insertChunks<T extends keyof DB>(
  trx: OrgTransaction,
  table: T,
  rows: Insertable<DB[T]>[],
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += 300) {
    await trx
      .insertInto(table)
      .values(rows.slice(offset, offset + 300))
      .execute();
  }
}

async function seedConsoleExamples(
  database: Kysely<DB>,
  spec: OrgSpec,
  orgId: string,
  adminId: string,
  familyAccountId: string,
): Promise<void> {
  const context = { orgId, actor: { accountId: adminId } };
  const withOrg = createWithOrg(database);
  const familyId = stableId(`demo-participant-${spec.seed}-0`);
  const householdId = stableId(`demo-household-${spec.seed}-0`);
  const campaignId = stableId(`demo-campaign-${spec.seed}`);
  const conversationId = stableId(`demo-conversation-${spec.seed}`);

  await withOrg(context, async (trx) => {
    await trx
      .insertInto('message_campaigns')
      .values({
        id: campaignId,
        org_id: orgId,
        author_account_id: adminId,
        channels: ['email'],
        subject: '2026 season welcome — draft',
        body_text:
          'This fictional sample is a draft only. No email or other message has been sent.',
        locale_variants: {
          en: {
            subject: '2026 season welcome',
            bodyHtml: '',
            bodyText: 'Welcome to the fictional 2026 season.',
            smsText: '',
            pushText: '',
          },
          es: {
            subject: 'Bienvenidos a la temporada 2026',
            bodyHtml: '',
            bodyText: 'Les damos la bienvenida a la temporada ficticia 2026.',
            smsText: '',
            pushText: '',
          },
        },
        audience: {
          include: { personIds: [familyId] },
          exclude: {},
          filters: {},
        },
        category: 'announcement',
        status: 'draft',
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await trx
      .insertInto('conversations')
      .values({
        id: conversationId,
        org_id: orgId,
        kind: 'announcement',
        title: '2026 season welcome',
        created_by: adminId,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await trx
      .insertInto('conversation_members')
      .values([
        {
          id: stableId(`demo-conversation-admin-${spec.seed}`),
          org_id: orgId,
          conversation_id: conversationId,
          account_id: adminId,
          role: 'owner',
        },
        {
          id: stableId(`demo-conversation-family-${spec.seed}`),
          org_id: orgId,
          conversation_id: conversationId,
          account_id: familyAccountId,
          role: 'member',
        },
      ])
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await trx
      .insertInto('chat_messages')
      .values({
        id: stableId(`demo-chat-message-${spec.seed}`),
        org_id: orgId,
        conversation_id: conversationId,
        author_account_id: adminId,
        body: 'Welcome to the fictional 2026 season. This is sample chat content; no external message was sent.',
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  });

  await withOrg(context, async (trx) => {
    await trx
      .insertInto('fundraising_settings')
      .values({
        org_id: orgId,
        is_nonprofit: spec.kind === 'league' || spec.kind === 'association',
        ein_ciphertext: null,
        ein_nonce: null,
        ein_key_version: null,
        show_full_ein: false,
        updated_by: adminId,
        created_at: SEED_TIME,
        updated_at: SEED_TIME,
      })
      .onConflict((oc) => oc.column('org_id').doNothing())
      .execute();

    await trx
      .insertInto('fundraising_campaigns')
      .values({
        id: stableId(`demo-fundraising-${spec.seed}`),
        org_id: orgId,
        name: 'Season equipment and access fund',
        slug: 'season-equipment-access',
        goal_cents: 250_000,
        starts_at: new Date('2026-08-01T00:00:00.000Z'),
        ends_at: new Date('2026-12-31T23:59:59.000Z'),
        team_season_id:
          spec.teamCount > 0
            ? stableId(`demo-teamseason-${spec.seed}-0`)
            : null,
        description_html:
          '<p>Fictional campaign for demonstration. No donations have been collected.</p>',
        image_file_id: null,
        status: 'draft',
        show_donor_names: false,
        created_by: adminId,
        created_at: SEED_TIME,
        updated_at: SEED_TIME,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await trx
      .insertInto('sponsors')
      .values({
        id: stableId(`demo-sponsor-${spec.seed}`),
        org_id: orgId,
        name: 'Example Community Sports Partner',
        contact: {
          name: 'Demo Partner Contact',
          email: `partner@${spec.slug}.example.test`,
        },
        logo_file_id: null,
        website_url: 'https://partner.example.test',
        tier: 'Community',
        amount_cents: 150_000,
        contract_start: '2026-01-01',
        contract_end: '2026-12-31',
        placements: JSON.stringify([{ surface: 'website_home' }]),
        invoice_id: null,
        status: 'prospect',
        renewal_notified_at: null,
        created_by: adminId,
        created_at: SEED_TIME,
        updated_at: SEED_TIME,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    const categoryId = stableId(`demo-store-category-${spec.seed}`);
    const productId = stableId(`demo-store-product-${spec.seed}`);
    const variantId = stableId(`demo-store-variant-${spec.seed}`);
    await trx
      .insertInto('product_categories')
      .values({
        id: categoryId,
        org_id: orgId,
        name: 'Demonstration gear',
        sort_order: 10,
        archived_at: null,
        created_at: SEED_TIME,
        updated_at: SEED_TIME,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await trx
      .insertInto('products')
      .values({
        id: productId,
        org_id: orgId,
        category_id: categoryId,
        name: 'Practice shirt',
        description: 'Fictional demonstration stock; no order has been placed.',
        kind: 'uniform',
        required_for_registration: false,
        active: true,
        created_by: adminId,
        created_at: SEED_TIME,
        updated_at: SEED_TIME,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await trx
      .insertInto('product_variants')
      .values({
        id: variantId,
        org_id: orgId,
        product_id: productId,
        sku: `DEMO-SHIRT-${spec.seed.toUpperCase()}`,
        size: 'Adult Medium',
        color: 'Blue',
        attributes: {},
        price_cents: 2_500,
        tax_rate_id: null,
        low_stock_threshold: 2,
        archived_at: null,
        created_at: SEED_TIME,
        updated_at: SEED_TIME,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await trx
      .insertInto('inventory_movements')
      .values({
        id: stableId(`demo-store-receive-${spec.seed}`),
        org_id: orgId,
        product_variant_id: variantId,
        movement: 'receive',
        quantity: 8,
        order_line_id: null,
        memo: 'Fictional demonstration stock; not sold.',
        created_by: adminId,
        created_at: SEED_TIME,
        updated_at: SEED_TIME,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    if (spec.teamCount > 0) {
      const teamSeasonId = stableId(`demo-teamseason-${spec.seed}-0`);
      await trx
        .insertInto('team_fee_assessments')
        .values({
          id: stableId(`demo-team-fee-assessment-${spec.seed}`),
          org_id: orgId,
          team_season_id: teamSeasonId,
          per_player_cents: 15_000,
          due_on: '2026-12-01',
          installment_template_id: null,
          installment_plan: null,
          status: 'draft',
          created_by: adminId,
          created_at: SEED_TIME,
          updated_at: SEED_TIME,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    }
  });

  const invoices = new PostgresInvoiceRepository(database, context);
  await invoices.issue({
    orgId,
    accountId: familyAccountId,
    householdId,
    source: 'staff',
    dueOn: '2026-12-15',
    memo: 'Fictional demo invoice. No payment has been processed.',
    creationKey: stableId(`demo-invoice-${spec.seed}`),
    lines: [
      {
        kind: 'registration',
        description: 'Example program balance — demo data only',
        amountCents: 12_500,
        refundable: true,
      },
    ],
  });
}

async function seedFederationMembers(
  database: Kysely<DB>,
  spec: OrgSpec,
  orgId: string,
  adminId: string,
): Promise<void> {
  if (!spec.memberClubSeeds?.length) return;
  const context: OrgContext = { orgId, actor: { accountId: adminId } };
  const current = await listRelationships(database, context);

  for (const [index, memberSeed] of spec.memberClubSeeds.entries()) {
    const childOrgId = stableId(`demo-org-${memberSeed}`);
    const childAdminId = stableId(`demo-admin-${memberSeed}`);
    const existing = current.find(
      (relationship) =>
        relationship.parentOrgId === orgId &&
        relationship.childOrgId === childOrgId &&
        ['invited', 'active', 'suspended'].includes(relationship.status),
    );
    if (!existing) {
      const invitation = await createRelationship(database, context, {
        direction: 'invite',
        organizationId: childOrgId,
        type: 'member_club',
        dataSharing: { team_entries: true },
        note: 'Fictional demo membership; only league team entries are shared.',
      });
      await acceptRelationship(
        { orgId: childOrgId, actor: { accountId: childAdminId } },
        invitation.id,
      );
    } else if (existing.status === 'invited') {
      await acceptRelationship(
        { orgId: childOrgId, actor: { accountId: childAdminId } },
        existing.id,
      );
    }

    const divisionIndex = index % 2;
    await createWithOrg(database)(context, async (trx) => {
      const programId = stableId(`demo-program-${spec.seed}-0`);
      const divisionId = stableId(
        `demo-division-${spec.seed}-0-${String(divisionIndex)}`,
      );
      const offeringId = stableId(
        `demo-offering-${spec.seed}-0-${String(divisionIndex)}-team`,
      );
      await trx
        .insertInto('registration_offerings')
        .values({
          id: offeringId,
          org_id: orgId,
          program_id: programId,
          division_id: divisionId,
          name: 'Inter-club team entry',
          registrant_role: 'team_entry',
          price_cents: 0,
          visibility: 'public',
          active: true,
          sort_order: 1,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      await trx
        .updateTable('external_teams')
        .set({ linked_org_id: childOrgId })
        .where(
          'id',
          '=',
          stableId(`demo-external-team-${spec.seed}-${String(index)}`),
        )
        .where('linked_org_id', 'is', null)
        .execute();
      await trx
        .insertInto('team_entries')
        .values({
          id: stableId(`demo-federation-entry-${spec.seed}-${String(index)}`),
          org_id: orgId,
          program_id: programId,
          division_id: divisionId,
          offering_id: offeringId,
          external_team_id: stableId(
            `demo-external-team-${spec.seed}-${String(index)}`,
          ),
          entrant_org_id: childOrgId,
          contact_account_id: childAdminId,
          status: 'accepted',
          seed_hint: index + 1,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
    });
  }
}

export async function seedDemo(database: Kysely<DB>): Promise<void> {
  const passwordHash = await hashPassword('Athlentry-Demo-2026!');
  const withOrg = createWithOrg(database);

  for (const spec of ORGS) {
    const orgId = stableId(`demo-org-${spec.seed}`);
    const adminId = stableId(`demo-admin-${spec.seed}`);
    const familyAccountId = stableId(`demo-family-${spec.seed}`);
    await database
      .insertInto('organizations')
      .values({
        id: orgId,
        slug: spec.slug,
        name: spec.name,
        kind: spec.kind,
        timezone: spec.timezone,
        email: `hello@${spec.slug}.example.test`,
        status: 'active',
        nonprofit: spec.kind === 'league' || spec.kind === 'association',
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await database
      .insertInto('accounts')
      .values({
        id: adminId,
        email: `admin@${spec.slug}.example.test`,
        first_name: 'Demo',
        last_name: 'Administrator',
        date_of_birth: '1985-04-12',
        password_hash: passwordHash,
        email_verified_at: SEED_TIME,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    await database
      .insertInto('accounts')
      .values({
        id: familyAccountId,
        email: `family@${spec.slug}.example.test`,
        first_name: 'Demo',
        last_name: 'Guardian',
        date_of_birth: '1988-09-02',
        password_hash: passwordHash,
        email_verified_at: SEED_TIME,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();

    await withOrg({ orgId, actor: { accountId: adminId } }, async (trx) => {
      const existing = await trx
        .selectFrom('sport_profiles')
        .select('id')
        .where('org_id', '=', orgId)
        .executeTakeFirst();
      if (existing) return;

      await trx
        .insertInto('org_memberships')
        .values({
          id: stableId(`demo-member-${spec.seed}`),
          org_id: orgId,
          account_id: adminId,
          status: 'active',
          title: 'Administrator',
          joined_at: SEED_TIME,
        })
        .execute();
      await trx
        .insertInto('role_assignments')
        .values({
          id: stableId(`demo-role-${spec.seed}`),
          org_id: orgId,
          account_id: adminId,
          role: 'owner',
          scope_type: 'org',
          granted_by: adminId,
        })
        .execute();

      const seasonId = stableId(`demo-season-${spec.seed}`);
      await trx
        .insertInto('seasons')
        .values({
          id: seasonId,
          org_id: orgId,
          name: '2026 Season',
          starts_on: '2026-08-01',
          ends_on: '2026-12-31',
        })
        .execute();

      const sportIds = new Map<string, string>();
      for (const sportKey of spec.sports) {
        const sportId = stableId(`demo-sport-${spec.seed}-${sportKey}`);
        sportIds.set(sportKey, sportId);
        await trx
          .insertInto('sport_profiles')
          .values({
            id: sportId,
            org_id: orgId,
            name: template(sportKey).name.en,
            profile: JSON.parse(JSON.stringify(template(sportKey))) as never,
          })
          .execute();
      }

      const facilityIds: string[] = [];
      for (const [index, facilityName] of spec.facilityNames.entries()) {
        const facilityId = stableId(
          `demo-facility-${spec.seed}-${String(index)}`,
        );
        facilityIds.push(facilityId);
        await trx
          .insertInto('facilities')
          .values({
            id: facilityId,
            org_id: orgId,
            name: facilityName,
            ownership: index === 0 ? 'owned' : 'permitted',
            timezone: spec.timezone,
            address: {
              line1: '100 Demo Way',
              city: spec.city,
              state: spec.state,
              postalCode: '00000',
            },
            public: true,
          })
          .execute();
        await trx
          .insertInto('spaces')
          .values({
            id: stableId(`demo-space-${spec.seed}-${String(index)}`),
            org_id: orgId,
            facility_id: facilityId,
            name: facilityName.includes('Center') ? 'Main Floor' : 'Main Space',
            kind: facilityName.toLowerCase().includes('aquatic')
              ? 'pool'
              : facilityName.toLowerCase().includes('track')
                ? 'track'
                : facilityName.toLowerCase().includes('softball')
                  ? 'diamond'
                  : facilityName.toLowerCase().includes('gym') ||
                      facilityName.toLowerCase().includes('volleyball') ||
                      facilityName.toLowerCase().includes('pickleball')
                    ? 'court'
                    : facilityName.toLowerCase().includes('wrestling') ||
                        facilityName.toLowerCase().includes('gymnastics')
                      ? 'mat'
                      : spec.facilityKind,
            has_lights: true,
            capacity_people: 500,
          })
          .execute();
      }

      const programRefs: {
        id: string;
        spec: ProgramSpec;
        divisions: {
          id: string;
          name: string;
          athleteOfferingId: string;
          teamOfferingId: string | null;
        }[];
      }[] = [];
      const eventRows: Insertable<DB['events']>[] = [];
      for (const [programIndex, program] of spec.programs.entries()) {
        const programId = stableId(
          `demo-program-${spec.seed}-${String(programIndex)}`,
        );
        await trx
          .insertInto('programs')
          .values({
            id: programId,
            org_id: orgId,
            season_id: seasonId,
            sport_profile_id: requiredValue(
              sportIds.get(program.sportKey),
              `sport ${program.sportKey}`,
            ),
            mode: program.mode,
            name: program.name,
            slug: `${spec.slug}-p${String(programIndex + 1)}`,
            starts_on: '2026-08-01',
            ends_on: '2026-12-31',
            status: 'registration_open',
            visibility: 'public',
            registration_opens_at: new Date('2026-01-15T00:00:00.000Z'),
            registration_closes_at: new Date('2026-12-15T23:59:00.000Z'),
            default_facility_id: valueAt(
              facilityIds,
              programIndex % facilityIds.length,
              'facility',
            ),
          })
          .execute();
        const divisions: {
          id: string;
          name: string;
          athleteOfferingId: string;
          teamOfferingId: string | null;
        }[] = [];
        for (const [
          divisionIndex,
          divisionName,
        ] of program.divisions.entries()) {
          const divisionId = stableId(
            `demo-division-${spec.seed}-${String(programIndex)}-${String(divisionIndex)}`,
          );
          const athleteOfferingId = stableId(
            `demo-offering-${spec.seed}-${String(programIndex)}-${String(divisionIndex)}-athlete`,
          );
          const teamOfferingId =
            program.teamEntryPriceCents === undefined
              ? null
              : stableId(
                  `demo-offering-${spec.seed}-${String(programIndex)}-${String(divisionIndex)}-team`,
                );
          await trx
            .insertInto('divisions')
            .values({
              id: divisionId,
              org_id: orgId,
              program_id: programId,
              name: divisionName,
              code: divisionName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
              age_label: divisionName,
              level: 'open',
              sort_order: divisionIndex,
            })
            .execute();
          await trx
            .insertInto('registration_offerings')
            .values({
              id: athleteOfferingId,
              org_id: orgId,
              program_id: programId,
              division_id: divisionId,
              name: `${divisionName} Participant`,
              registrant_role: 'athlete',
              price_cents: program.priceCents,
              visibility: 'public',
              active: true,
              sort_order: 0,
            })
            .execute();
          if (teamOfferingId)
            await trx
              .insertInto('registration_offerings')
              .values({
                id: teamOfferingId,
                org_id: orgId,
                program_id: programId,
                division_id: divisionId,
                name: `${divisionName} Team Entry`,
                registrant_role: 'team_entry',
                price_cents: requiredValue(
                  program.teamEntryPriceCents,
                  'team entry price',
                ),
                visibility: 'public',
                active: true,
                sort_order: 1,
              })
              .execute();
          divisions.push({
            id: divisionId,
            name: divisionName,
            athleteOfferingId,
            teamOfferingId,
          });
        }
        programRefs.push({ id: programId, spec: program, divisions });
        const eventKind =
          program.mode === 'class'
            ? 'class_session'
            : program.mode === 'tournament' ||
                program.sportKey === 'track_field'
              ? 'meet'
              : program.sportKey === 'wrestling'
                ? 'bout_session'
                : program.sportKey === 'volleyball' ||
                    program.sportKey === 'pickleball'
                  ? 'match'
                  : 'game';
        const spaceId = stableId(
          `demo-space-${spec.seed}-${String(programIndex % facilityIds.length)}`,
        );
        eventRows.push({
          id: stableId(`demo-event-${spec.seed}-${String(programIndex)}`),
          org_id: orgId,
          program_id: programId,
          division_id: divisions[0]?.id ?? null,
          kind: eventKind,
          title: `${program.name} - Season Welcome`,
          starts_at: new Date('2026-10-10T16:00:00.000Z'),
          ends_at: new Date('2026-10-10T18:00:00.000Z'),
          timezone: spec.timezone,
          space_id: spaceId,
          location_text: valueAt(
            spec.facilityNames,
            programIndex % facilityIds.length,
            'facility name',
          ),
          status: 'scheduled',
          published: true,
        });
      }

      const teams: {
        id: string;
        teamSeasonId: string;
        programId: string;
        divisionId: string;
        name: string;
        sportKey: string;
      }[] = [];
      for (let index = 0; index < spec.teamCount; index += 1) {
        const primaryProgram =
          programRefs.find(
            (item) =>
              item.spec.sportKey ===
              valueAt(spec.sports, index % spec.sports.length, 'sport'),
          ) ?? valueAt(programRefs, 0, 'program');
        const division = valueAt(
          primaryProgram.divisions,
          index % primaryProgram.divisions.length,
          'division',
        );
        const teamId = stableId(`demo-team-${spec.seed}-${String(index)}`);
        const teamSeasonId = stableId(
          `demo-teamseason-${spec.seed}-${String(index)}`,
        );
        const teamName =
          spec.seed === 'summit'
            ? `${valueAt(['14U', '15U', '16U', '17U', '18U'], index % 5, 'age group')} ${valueAt(['Peak', 'Crest', 'Alpine', 'Aspen', 'Pine'], Math.floor(index / 5), 'team name')} ${String(index + 1)}`
            : spec.seed === 'riverside'
              ? `${division.name} ${valueAt(['Rockets', 'River Foxes', 'Blue Herons', 'Otters', 'Comets'], index % 5, 'team name')} ${String(Math.floor(index / 5) + 1)}`
              : `${valueAt(spec.sports, index % spec.sports.length, 'sport').replace('_', ' ')} Demo Team ${String(index + 1)}`;
        await trx
          .insertInto('teams')
          .values({
            id: teamId,
            org_id: orgId,
            name: teamName,
            short_name: `T${String(index + 1)}`,
            sport_profile_id: requiredValue(
              sportIds.get(primaryProgram.spec.sportKey),
              `sport ${primaryProgram.spec.sportKey}`,
            ),
            age_label: division.name,
            level: 'recreational',
            status: 'active',
          })
          .execute();
        await trx
          .insertInto('team_seasons')
          .values({
            id: teamSeasonId,
            org_id: orgId,
            team_id: teamId,
            program_id: primaryProgram.id,
            division_id: division.id,
            display_name: teamName,
            roster_limit: 18,
            status: 'active',
            home_facility_id: valueAt(
              facilityIds,
              index % facilityIds.length,
              'home facility',
            ),
          })
          .execute();
        teams.push({
          id: teamId,
          teamSeasonId,
          programId: primaryProgram.id,
          divisionId: division.id,
          name: teamName,
          sportKey: primaryProgram.spec.sportKey,
        });
      }

      const people: Insertable<DB['people']>[] = [];
      const accounts: Insertable<DB['accounts']>[] = [];
      const households: Insertable<DB['households']>[] = [];
      const householdMembers: Insertable<DB['household_members']>[] = [];
      const accountLinks: Insertable<DB['person_account_links']>[] = [];
      const participants: {
        id: string;
        householdId: string;
        guardianId: string | null;
        accountId: string | null;
      }[] = [];
      for (let index = 0; index < spec.households; index += 1) {
        const householdId = stableId(
          `demo-household-${spec.seed}-${String(index)}`,
        );
        const adult = spec.adultMembers === true;
        const participantId = stableId(
          `demo-participant-${spec.seed}-${String(index)}`,
        );
        const guardianId = adult
          ? null
          : stableId(`demo-guardian-person-${spec.seed}-${String(index)}`);
        const name = personName(index);
        const householdName = `${name.last} Demo Household ${String(index + 1)}`;
        households.push({
          id: householdId,
          org_id: orgId,
          name: householdName,
        });
        if (guardianId) {
          people.push({
            id: guardianId,
            org_id: orgId,
            first_name: valueAt(
              FIRST,
              (index + 1) % FIRST.length,
              'guardian first name',
            ),
            last_name: name.last,
            date_of_birth: '1986-06-15',
            email: `guardian${String(index)}@${spec.slug}.example.test`,
          });
          householdMembers.push({
            id: stableId(
              `demo-household-guardian-${spec.seed}-${String(index)}`,
            ),
            org_id: orgId,
            household_id: householdId,
            person_id: guardianId,
            role: 'guardian',
            financially_responsible: true,
            is_primary_contact: true,
          });
        }
        people.push({
          id: participantId,
          org_id: orgId,
          first_name: name.first,
          last_name: name.last,
          date_of_birth: adult
            ? '1990-03-20'
            : spec.seed === 'riverside'
              ? `${String(2020 - (index % 9))}-03-20`
              : `201${String(index % 8)}-03-20`,
          competition_gender: index % 2 === 0 ? 'female' : 'male',
          email: adult
            ? `adult${String(index)}@${spec.slug}.example.test`
            : null,
        });
        householdMembers.push({
          id: stableId(
            `demo-household-participant-${spec.seed}-${String(index)}`,
          ),
          org_id: orgId,
          household_id: householdId,
          person_id: participantId,
          role: adult ? 'other_adult' : 'athlete',
          financially_responsible: adult,
          is_primary_contact: adult,
        });
        let linkedAccount: string | null = null;
        if (adult) {
          linkedAccount = stableId(
            `demo-adult-account-${spec.seed}-${String(index)}`,
          );
          await trx
            .insertInto('accounts')
            .values({
              id: linkedAccount,
              email: `adult${String(index)}@${spec.slug}.example.test`,
              first_name: name.first,
              last_name: name.last,
              date_of_birth: '1990-03-20',
              password_hash: passwordHash,
              email_verified_at: SEED_TIME,
            })
            .onConflict((oc) => oc.column('id').doNothing())
            .execute();
          accountLinks.push({
            id: stableId(`demo-adult-link-${spec.seed}-${String(index)}`),
            org_id: orgId,
            account_id: linkedAccount,
            person_id: participantId,
            relationship: 'self',
            verified_at: SEED_TIME,
          });
        } else if (index === 0) {
          linkedAccount = familyAccountId;
          if (!guardianId) throw new Error('Missing family guardian');
          accountLinks.push({
            id: stableId(`demo-family-link-${spec.seed}`),
            org_id: orgId,
            account_id: familyAccountId,
            person_id: guardianId,
            relationship: 'guardian',
            verified_at: SEED_TIME,
          });
        } else if (spec.seed === 'northstar' && guardianId) {
          linkedAccount = stableId(
            `demo-family-account-${spec.seed}-${String(index)}`,
          );
          accounts.push({
            id: linkedAccount,
            email: `family${String(index)}@${spec.slug}.example.test`,
            first_name: 'Demo',
            last_name: `Guardian ${String(index + 1)}`,
            date_of_birth: '1986-06-15',
            password_hash: passwordHash,
            email_verified_at: SEED_TIME,
          });
          accountLinks.push({
            id: stableId(`demo-family-link-${spec.seed}-${String(index)}`),
            org_id: orgId,
            account_id: linkedAccount,
            person_id: guardianId,
            relationship: 'guardian',
            verified_at: SEED_TIME,
          });
        }
        participants.push({
          id: participantId,
          householdId,
          guardianId,
          accountId: linkedAccount,
        });
      }
      await insertChunks(trx, 'accounts', accounts);
      await insertChunks(trx, 'people', people);
      await insertChunks(trx, 'households', households);
      await insertChunks(trx, 'household_members', householdMembers);
      await insertChunks(trx, 'person_account_links', accountLinks);
      await insertChunks(trx, 'events', eventRows);

      const registrations: Insertable<DB['registrations']>[] = [];
      const rosters: Insertable<DB['roster_entries']>[] = [];
      const jerseyNumbers = new Map<string, number>();
      for (const [index, participant] of participants.entries()) {
        const program = valueAt(
          programRefs,
          index % programRefs.length,
          'program',
        );
        const division = valueAt(
          program.divisions,
          index % program.divisions.length,
          'division',
        );
        const candidateTeams = teams.filter(
          (team) =>
            team.programId === program.id && team.divisionId === division.id,
        );
        const team = candidateTeams[index % Math.max(candidateTeams.length, 1)];
        const registrationId = stableId(
          `demo-registration-${spec.seed}-${String(index)}`,
        );
        const status =
          spec.seed === 'summit' && index % 12 === 0 ? 'offered' : 'confirmed';
        registrations.push({
          id: registrationId,
          org_id: orgId,
          program_id: program.id,
          division_id: division.id,
          offering_id: division.athleteOfferingId,
          person_id: participant.id,
          household_id: participant.householdId,
          registered_by_account_id: adminId,
          status,
          source: 'staff',
          team_season_id: team?.teamSeasonId ?? null,
        });
        if (team && status === 'confirmed') {
          const jerseyNumber = (jerseyNumbers.get(team.teamSeasonId) ?? 0) + 1;
          jerseyNumbers.set(team.teamSeasonId, jerseyNumber);
          rosters.push({
            id: stableId(`demo-roster-${spec.seed}-${String(index)}`),
            org_id: orgId,
            team_season_id: team.teamSeasonId,
            person_id: participant.id,
            registration_id: registrationId,
            jersey_number: String(jerseyNumber),
            kind: 'rostered',
            status: 'active',
            joined_on: '2026-08-01',
          });
        }
      }
      await insertChunks(trx, 'registrations', registrations);
      await insertChunks(trx, 'roster_entries', rosters);

      if (spec.seed === 'northstar') {
        const levelNames = ['Beginner', 'Intermediate', 'Advanced'];
        const skillLevelIds = new Map<string, Map<string, string>>();
        const skillLevels: Insertable<DB['skill_levels']>[] = [];
        const skills: Insertable<DB['skills']>[] = [];
        for (const sportKey of spec.sports) {
          const levels = new Map<string, string>();
          const sportProfileId = requiredValue(
            sportIds.get(sportKey),
            `sport ${sportKey}`,
          );
          for (const [index, name] of levelNames.entries()) {
            const skillLevelId = stableId(
              `demo-skill-level-northstar-${sportKey}-${String(index)}`,
            );
            levels.set(name, skillLevelId);
            skillLevels.push({
              id: skillLevelId,
              org_id: orgId,
              sport_profile_id: sportProfileId,
              name,
              description: `${name} ${sportKey} skills`,
              sort_order: index + 1,
            });
            for (const [skillIndex, skillName] of [
              'Body control',
              'Technique',
              'Confidence',
            ].entries()) {
              skills.push({
                id: stableId(
                  `demo-skill-northstar-${sportKey}-${String(index)}-${String(skillIndex)}`,
                ),
                org_id: orgId,
                skill_level_id: skillLevelId,
                name: `${name} ${skillName}`,
                description: `Demonstration ${sportKey} skill objective.`,
                sort_order: skillIndex + 1,
              });
            }
          }
          skillLevelIds.set(sportKey, levels);
        }
        await insertChunks(trx, 'skill_levels', skillLevels);
        await insertChunks(trx, 'skills', skills);

        const classPrograms = programRefs.filter(
          (program) => program.spec.mode === 'class',
        );
        const offerings: Insertable<DB['class_offerings']>[] = [];
        const schedules: Insertable<DB['class_schedules']>[] = [];
        const sessions: Insertable<DB['class_sessions']>[] = [];
        for (const [index, program] of classPrograms.entries()) {
          const levelNumber = Number(
            /Level (\d+)/.exec(program.spec.name)?.[1] ?? '1',
          );
          const levelName =
            levelNumber <= 3
              ? 'Beginner'
              : levelNumber <= 6
                ? 'Intermediate'
                : 'Advanced';
          const offeringId = stableId(
            `demo-class-offering-northstar-${String(index)}`,
          );
          const scheduleId = stableId(
            `demo-class-schedule-northstar-${String(index)}`,
          );
          const event = eventRows.find((row) => row.program_id === program.id);
          if (!event)
            throw new Error(`Missing class event ${program.spec.name}`);
          const sportLevels = requiredValue(
            skillLevelIds.get(program.spec.sportKey),
            `skill levels for ${program.spec.sportKey}`,
          );
          offerings.push({
            id: offeringId,
            org_id: orgId,
            program_id: program.id,
            skill_level_id: requiredValue(
              sportLevels.get(levelName),
              `${levelName} ${program.spec.sportKey} level`,
            ),
            name: program.spec.name,
            description: 'Weekly academy class with monthly tuition.',
            age_min_months: 36,
            age_max_months: 216,
            capacity: 18,
            instructor_ratio: '8',
            billing: 'monthly',
            price_cents: program.spec.priceCents,
            trial_allowed: true,
            trial_price_cents: 0,
            annual_fee_cents: 2500,
            makeup_policy: {
              creditsPerTerm: 0,
              expiryDays: 90,
              eligibleLevelIds: null,
              eligibleOfferingIds: null,
            },
            sibling_discount_bps: [0, 1000],
            status: 'active',
          });
          schedules.push({
            id: scheduleId,
            org_id: orgId,
            class_offering_id: offeringId,
            recurrence: {
              kind: 'weekly',
              interval: 1,
              byDay: ['SA'],
              startsOn: '2026-10-10',
              endsOn: '2026-10-10',
              exceptions: [],
              additions: [],
            },
            start_time: '11:00',
            duration_minutes: 120,
            timezone: spec.timezone,
            space_id: stableId(
              `demo-space-northstar-${String(index % facilityIds.length)}`,
            ),
            location_text: valueAt(
              spec.facilityNames,
              index % facilityIds.length,
              'academy facility',
            ),
            term_start: '2026-08-01',
            term_end: '2026-12-31',
            status: 'active',
          });
          sessions.push({
            id: stableId(`demo-class-session-northstar-${String(index)}`),
            org_id: orgId,
            event_id: event.id,
            class_offering_id: offeringId,
            class_schedule_id: scheduleId,
            capacity: 18,
            holiday_skipped: false,
          });
        }
        await insertChunks(trx, 'class_offerings', offerings);
        await insertChunks(trx, 'class_schedules', schedules);
        await insertChunks(trx, 'class_sessions', sessions);

        const tuitionSubscriptions: Insertable<DB['tuition_subscriptions']>[] =
          [];
        const classEnrollments: Insertable<DB['class_enrollments']>[] = [];
        for (const [index, participant] of participants.entries()) {
          const offering = valueAt(
            offerings,
            index % offerings.length,
            'academy class offering',
          );
          const accountId = participant.accountId;
          if (!accountId) throw new Error('Missing Northstar guardian account');
          const tuitionSubscriptionId = stableId(
            `demo-tuition-subscription-northstar-${String(index)}`,
          );
          tuitionSubscriptions.push({
            id: tuitionSubscriptionId,
            org_id: orgId,
            account_id: accountId,
            household_id: participant.householdId,
            billing_day: 1,
            next_bill_on: '2026-10-01',
            status: 'active',
            proration: 'session_count',
          });
          classEnrollments.push({
            id: stableId(`demo-class-enrollment-northstar-${String(index)}`),
            org_id: orgId,
            class_offering_id: offering.id,
            person_id: participant.id,
            household_id: participant.householdId,
            account_id: accountId,
            status: 'active',
            starts_on: '2026-08-01',
            ends_on: '2026-12-31',
            billing_subscription_id: tuitionSubscriptionId,
          });
        }
        await insertChunks(trx, 'tuition_subscriptions', tuitionSubscriptions);
        await insertChunks(trx, 'class_enrollments', classEnrollments);
      }

      const teamStaff: Insertable<DB['team_staff']>[] = teams
        .slice(0, Math.min(teams.length, 8))
        .map((team, index) => ({
          id: stableId(`demo-team-staff-${spec.seed}-${String(index)}`),
          org_id: orgId,
          team_season_id: team.teamSeasonId,
          person_id:
            valueAt(participants, 0, 'demo participant').guardianId ??
            valueAt(participants, 0, 'demo participant').id,
          role: 'head_coach',
          status: 'pending_compliance',
          added_by: adminId,
        }));
      await insertChunks(trx, 'team_staff', teamStaff);

      if (spec.externalTeams?.length) {
        const externals: Insertable<DB['external_teams']>[] =
          spec.externalTeams.map((name, index) => ({
            id: stableId(`demo-external-team-${spec.seed}-${String(index)}`),
            org_id: orgId,
            name,
            club_name: name,
            contact_name: 'Demo Club Contact',
            contact_email: `club${String(index)}@${spec.slug}.example.test`,
            sport_profile_id: requiredValue(
              sportIds.get(valueAt(spec.sports, 0, 'sport')),
              'external team sport',
            ),
            age_label: 'U14',
            linked_org_id: spec.memberClubSeeds?.[index]
              ? stableId(`demo-org-${spec.memberClubSeeds[index]}`)
              : null,
          }));
        await insertChunks(trx, 'external_teams', externals);
        if (eventRows[0]) {
          const externalParticipants: Insertable<DB['event_participants']>[] =
            externals.map((external, index) => ({
              id: stableId(
                `demo-event-participant-${spec.seed}-${String(index)}`,
              ),
              org_id: orgId,
              event_id: valueAt(eventRows, 0, 'event').id,
              external_team_id: external.id,
              side: index === 0 ? 'home' : 'away',
            }));
          await insertChunks(trx, 'event_participants', externalParticipants);
        }
        const tournament = programRefs.find(
          (program) => program.spec.mode === 'tournament',
        );
        if (tournament) {
          const teamOfferingId = valueAt(
            tournament.divisions,
            0,
            'tournament division',
          ).athleteOfferingId;
          const entries: Insertable<DB['team_entries']>[] = externals.map(
            (external, index) => ({
              id: stableId(`demo-team-entry-${spec.seed}-${String(index)}`),
              org_id: orgId,
              program_id: tournament.id,
              division_id: valueAt(
                tournament.divisions,
                index % tournament.divisions.length,
                'tournament division',
              ).id,
              offering_id: teamOfferingId,
              external_team_id: external.id,
              status: 'accepted',
              seed_hint: index + 1,
            }),
          );
          await insertChunks(trx, 'team_entries', entries);
        }
      }
      const internalTeamEntries: Insertable<DB['team_entries']>[] = [];
      for (const program of programRefs) {
        if (!program.spec.teamEntryPriceCents) continue;
        for (const team of teams.filter(
          (item) => item.programId === program.id,
        )) {
          const division = program.divisions.find(
            (item) => item.id === team.divisionId,
          );
          if (!division)
            throw new Error(`Missing division for team ${team.id}`);
          if (!division.teamOfferingId) continue;
          internalTeamEntries.push({
            id: stableId(`demo-team-entry-${spec.seed}-${team.id}`),
            org_id: orgId,
            program_id: program.id,
            division_id: division.id,
            offering_id: division.teamOfferingId,
            team_season_id: team.teamSeasonId,
            status: 'accepted',
            captain_person_id: valueAt(participants, 0, 'demo participant').id,
            contact_account_id: familyAccountId,
          });
        }
      }
      await insertChunks(trx, 'team_entries', internalTeamEntries);

      if (spec.officialCount) {
        const officials: Insertable<DB['people']>[] = [];
        const profiles: Insertable<DB['official_profiles']>[] = [];
        for (let index = 0; index < spec.officialCount; index += 1) {
          const personId = stableId(
            `demo-official-person-${spec.seed}-${String(index)}`,
          );
          const name = personName(index + 9);
          officials.push({
            id: personId,
            org_id: orgId,
            first_name: name.first,
            last_name: `Official ${name.last}`,
            date_of_birth: '1980-01-15',
            email: `official${String(index)}@${spec.slug}.example.test`,
          });
          profiles.push({
            id: stableId(`demo-official-profile-${spec.seed}-${String(index)}`),
            org_id: orgId,
            person_id: personId,
            sports: spec.sports.map((sportKey) =>
              requiredValue(
                sportIds.get(sportKey),
                `official sport ${sportKey}`,
              ),
            ),
            grade: 'Certified',
            level: 'regional',
            home_area: spec.city,
            max_games_per_day: 3,
            travel_radius_km: 40,
          });
        }
        await insertChunks(trx, 'people', officials);
        await insertChunks(trx, 'official_profiles', profiles);
      }

      const credentialTypeId = stableId(`demo-credential-type-${spec.seed}`);
      await trx
        .insertInto('credential_types')
        .values({
          id: credentialTypeId,
          org_id: orgId,
          key: 'coach_safety_training',
          name: 'Coach safety training',
          description:
            'Demonstration requirement; no credential documents are included.',
          verification: 'manual_staff',
          validity: { months: 12 },
          applies_to: { roles: ['head_coach'] },
          blocks_activation: true,
        })
        .execute();
      await trx
        .insertInto('role_credential_requirements')
        .values({
          id: stableId(`demo-credential-requirement-${spec.seed}`),
          org_id: orgId,
          credential_type_id: credentialTypeId,
          role: 'head_coach',
          scope_type: 'org',
          scope_id: null,
          active: true,
          minimum_age: 18,
        })
        .execute();

      const volunteerSchema = await sql<{ available: boolean }>`
        SELECT to_regclass('volunteer_roles') IS NOT NULL AS available
      `.execute(trx);
      if (spec.seed === 'riverside' && volunteerSchema.rows[0]?.available) {
        const volunteerRoleId = stableId(`demo-volunteer-role-${spec.seed}`);
        await sql`
          INSERT INTO volunteer_roles
            (id, org_id, name, description, minimum_age, created_by)
          VALUES
            (${volunteerRoleId}, ${orgId}, 'Event helper', 'Demo volunteer role', 16, ${adminId})
        `.execute(trx);
        const completedShiftId = stableId(
          `demo-volunteer-shift-completed-${spec.seed}`,
        );
        await sql`
          INSERT INTO volunteer_shifts
            (id, org_id, volunteer_role_id, facility_id, starts_at, ends_at,
             slots, credit_hours, notes, status, created_by)
          VALUES
            (${completedShiftId}, ${orgId}, ${volunteerRoleId}, ${valueAt(facilityIds, 0, 'volunteer facility')},
             '2026-08-15T15:00:00.000Z', '2026-08-15T17:00:00.000Z',
             1, 2, 'Fictional completed demo shift', 'completed', ${adminId})
        `.execute(trx);
        await sql`
          INSERT INTO volunteer_signups
            (id, org_id, volunteer_shift_id, person_id, household_id, status,
             hours_credited, credited_by, credited_at, created_by)
          VALUES
            (${stableId(`demo-volunteer-signup-${spec.seed}`)}, ${orgId}, ${completedShiftId},
             ${valueAt(participants, 0, 'demo participant').guardianId ?? valueAt(participants, 0, 'demo participant').id},
             ${valueAt(participants, 0, 'demo participant').householdId},
             'completed', 2, ${adminId}, '2026-08-15T17:00:00.000Z', ${adminId})
        `.execute(trx);
        await sql`
          INSERT INTO volunteer_shifts
            (id, org_id, volunteer_role_id, event_id, facility_id, starts_at, ends_at,
             slots, credit_hours, notes, created_by)
          VALUES
            (${stableId(`demo-volunteer-shift-open-${spec.seed}`)}, ${orgId}, ${volunteerRoleId},
             ${eventRows[0]?.id ?? null}, ${valueAt(facilityIds, 0, 'volunteer facility')},
             '2026-10-10T15:00:00.000Z', '2026-10-10T19:00:00.000Z',
             4, 2, 'Fictional demo shift; no notification has been sent.', ${adminId})
        `.execute(trx);
      }

      if (spec.closure)
        await trx
          .insertInto('closures')
          .values({
            id: stableId(`demo-weather-closure-${spec.seed}`),
            org_id: orgId,
            scope_type: 'facility',
            scope_id: valueAt(facilityIds, 0, 'closure facility'),
            starts_at: new Date('2026-10-18T00:00:00.000Z'),
            ends_at: new Date('2026-10-18T23:59:00.000Z'),
            reason: 'weather',
            message: 'Demo weather closure; no notifications are sent.',
            created_by: adminId,
          })
          .execute();
    });
    await seedConsoleExamples(database, spec, orgId, adminId, familyAccountId);
    await seedFederationMembers(database, spec, orgId, adminId);
  }
}

export async function seedLoad(database: Kysely<DB>): Promise<void> {
  const soccer = builtInSportTemplates.find(
    (candidate) => candidate.key === 'soccer',
  );
  if (!soccer) throw new Error('The built-in soccer template is unavailable');

  const loadOrgs = Array.from({ length: LOAD_ORG_COUNT }, (_, index) => {
    const suffix = String(index).padStart(3, '0');
    const legacyBase = index === 0;
    return {
      index,
      id: stableId(legacyBase ? 'load-org' : `load-org-${String(index)}`),
      slug: legacyBase ? 'load-org' : `load-org-${suffix}`,
      name: legacyBase
        ? 'Load Test Organization'
        : `Load Test Organization ${suffix}`,
      adminId: stableId(
        legacyBase ? 'load-admin' : `load-admin-${String(index)}`,
      ),
      adminEmail: legacyBase
        ? 'admin@load.example.test'
        : `admin+${suffix}@load.example.test`,
      peopleCount: index === 0 ? 20_000 : index <= 13 ? 1_314 : 1_313,
    };
  });

  await database
    .insertInto('organizations')
    .values(
      loadOrgs.map((org) => ({
        id: org.id,
        slug: org.slug,
        name: org.name,
        kind: 'league',
        timezone: 'America/Chicago',
        email: `hello+${org.slug}@load.example.test`,
        status: 'active',
        nonprofit: true,
      })),
    )
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  await database
    .insertInto('accounts')
    .values(
      loadOrgs.map((org) => ({
        id: org.adminId,
        email: org.adminEmail,
        first_name: 'Load',
        last_name: `Administrator ${String(org.index).padStart(3, '0')}`,
        date_of_birth: '1980-01-01',
        email_verified_at: SEED_TIME,
      })),
    )
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();

  const loadPasswordHash = await hashPassword('Athlentry-Load-2026!');
  const familyAccountId = loadUuid(sql`'load-family-account:' || n::text`);
  await sql`
    INSERT INTO accounts (
      id, email, password_hash, first_name, last_name, date_of_birth,
      email_verified_at, created_at, updated_at
    )
    SELECT
      ${familyAccountId},
      'load.family.' || lpad(n::text, 5, '0') || '@load.example.test',
      ${loadPasswordHash}, 'Load', 'Family ' || n::text, '1985-01-01',
      ${SEED_TIME}, ${SEED_TIME}, ${SEED_TIME}
    FROM generate_series(0, ${LOAD_FAMILY_ACCOUNTS - 1}) AS generated(n)
    ON CONFLICT (id) DO NOTHING
  `.execute(database);

  const coachAccountId = loadUuid(sql`'load-coach-account:' || n::text`);
  await sql`
    INSERT INTO accounts (
      id, email, password_hash, first_name, last_name, date_of_birth,
      email_verified_at, created_at, updated_at
    )
    SELECT
      ${coachAccountId},
      'load.coach.' || lpad(n::text, 3, '0') || '@load.example.test',
      ${loadPasswordHash}, 'Load', 'Coach ' || n::text, '1985-01-01',
      ${SEED_TIME}, ${SEED_TIME}, ${SEED_TIME}
    FROM generate_series(0, ${LOAD_COACH_ACCOUNTS - 1}) AS generated(n)
    ON CONFLICT (id) DO NOTHING
  `.execute(database);

  const withOrg = createWithOrg(database);
  for (const org of loadOrgs) {
    const orgId = org.id;
    const adminId = org.adminId;
    const isRegistrationOrg = org.index === 0;
    const programCount = isRegistrationOrg ? 5 : 4;
    const teamCount = isRegistrationOrg ? 10 : 0;
    const context = { orgId, actor: { accountId: adminId } };
    const seasonId = stableId(`load-season:${org.slug}`);
    const sportId = stableId(`load-sport:${org.slug}`);
    const programs = Array.from({ length: programCount }, (_, index) => ({
      id: stableId(`load-program:${org.slug}:${String(index)}`),
      org_id: orgId,
      season_id: seasonId,
      sport_profile_id: sportId,
      mode: 'league',
      name:
        isRegistrationOrg && index === 4
          ? 'Load registration spike program'
          : `Load soccer program ${String(index + 1)}`,
      slug: `${org.slug}-program-${String(index + 1)}`,
      status: 'registration_open',
      visibility: 'public',
      starts_on: '2027-01-01',
      ends_on: '2027-12-31',
      registration_opens_at: new Date('2026-08-01T00:00:00.000Z'),
      registration_closes_at: new Date('2027-02-01T00:00:00.000Z'),
      created_at: SEED_TIME,
      updated_at: SEED_TIME,
    }));
    const divisions = programs.map((program, index) => ({
      id: stableId(`load-division:${org.slug}:${String(index)}`),
      org_id: orgId,
      program_id: program.id,
      name: 'Open division',
      code: `LOAD-${String(index + 1)}`,
      level: 'open',
      sort_order: 0,
      created_at: SEED_TIME,
      updated_at: SEED_TIME,
    }));
    const standardOfferings = programs.slice(0, 4).map((program, index) => ({
      id: stableId(`load-offering:${org.slug}:${String(index)}`),
      org_id: orgId,
      program_id: program.id,
      division_id: divisions[index]?.id ?? null,
      name: `Load soccer offering ${String(index + 1)}`,
      registrant_role: 'athlete',
      price_cents: 0,
      capacity: null,
      visibility: 'public',
      active: true,
      sort_order: 0,
      created_at: SEED_TIME,
      updated_at: SEED_TIME,
    }));
    const spikeOfferings = isRegistrationOrg
      ? Array.from({ length: 10 }, (_, index) => ({
          id: stableId(`load-spike-offering:${org.slug}:${String(index)}`),
          org_id: orgId,
          program_id: programs[4]?.id ?? '',
          division_id: divisions[4]?.id ?? null,
          name: `Limited capacity test offering ${String(index + 1)}`,
          registrant_role: 'athlete',
          price_cents: 0,
          capacity: 100,
          visibility: 'public',
          active: true,
          sort_order: index,
          created_at: SEED_TIME,
          updated_at: SEED_TIME,
        }))
      : [];
    const teamIds = Array.from({ length: teamCount }, (_, index) =>
      stableId(`load-team:${org.slug}:${String(index)}`),
    );
    const teamSeasonIds = Array.from({ length: teamCount }, (_, index) =>
      stableId(`load-team-season:${org.slug}:${String(index)}`),
    );

    await withOrg(context, async (trx) => {
      const member = await trx
        .selectFrom('org_memberships')
        .select('id')
        .where('org_id', '=', orgId)
        .where('account_id', '=', adminId)
        .executeTakeFirst();
      if (!member) {
        await trx
          .insertInto('org_memberships')
          .values({
            id: stableId(`load-member:${org.slug}`),
            org_id: orgId,
            account_id: adminId,
            status: 'active',
            title: 'Load administrator',
            joined_at: SEED_TIME,
          })
          .execute();
      }
      const ownerRole = await trx
        .selectFrom('role_assignments')
        .select('id')
        .where('org_id', '=', orgId)
        .where('account_id', '=', adminId)
        .where('role', '=', 'owner')
        .where('scope_type', '=', 'org')
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (!ownerRole) {
        await trx
          .insertInto('role_assignments')
          .values({
            id: stableId(`load-role:${org.slug}`),
            org_id: orgId,
            account_id: adminId,
            role: 'owner',
            scope_type: 'org',
            granted_by: adminId,
            granted_at: SEED_TIME,
          })
          .execute();
      }

      await trx
        .insertInto('seasons')
        .values({
          id: seasonId,
          org_id: orgId,
          name: '2027 Load Season',
          starts_on: '2027-01-01',
          ends_on: '2027-12-31',
          status: 'active',
          created_at: SEED_TIME,
          updated_at: SEED_TIME,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      await trx
        .insertInto('sport_profiles')
        .values({
          id: sportId,
          org_id: orgId,
          name: soccer.name.en,
          profile: JSON.parse(JSON.stringify(soccer)) as never,
          created_at: SEED_TIME,
          updated_at: SEED_TIME,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      await trx
        .insertInto('programs')
        .values(programs)
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      await trx
        .insertInto('divisions')
        .values(divisions)
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      await trx
        .insertInto('registration_offerings')
        .values([...standardOfferings, ...spikeOfferings])
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();

      const programZero = programs[0];
      const divisionZero = divisions[0];
      if (!programZero || !divisionZero)
        throw new Error(`Missing base program for ${org.slug}`);

      if (isRegistrationOrg) {
        await trx
          .insertInto('teams')
          .values(
            teamIds.map((id, index) => ({
              id,
              org_id: orgId,
              name: `Load team ${String(index + 1).padStart(2, '0')}`,
              short_name: `LT${String(index + 1).padStart(2, '0')}`,
              sport_profile_id: sportId,
              competition_gender: 'open',
              birth_year: 2012,
              level: 'open',
              status: 'active',
              created_at: SEED_TIME,
              updated_at: SEED_TIME,
            })),
          )
          .onConflict((oc) => oc.column('id').doNothing())
          .execute();
        await trx
          .insertInto('team_seasons')
          .values(
            teamSeasonIds.map((id, index) => ({
              id,
              org_id: orgId,
              team_id: teamIds[index] ?? '',
              program_id: programZero.id,
              division_id: divisionZero.id,
              display_name: `Load team ${String(index + 1).padStart(2, '0')}`,
              roster_limit: 100,
              status: 'active',
              created_at: SEED_TIME,
              updated_at: SEED_TIME,
            })),
          )
          .onConflict((oc) => oc.column('id').doNothing())
          .execute();
      }

      const peopleId = loadUuid(
        sql`'load-person:' || ${orgId} || ':' || n::text`,
      );
      await sql`
        INSERT INTO people (
          id, org_id, first_name, last_name, date_of_birth,
          gender, status, created_at, updated_at
        )
        SELECT
          ${peopleId}, ${orgId}, 'Load',
          'Athlete ' || ${String(org.index).padStart(3, '0')} || '-' || lpad(n::text, 5, '0'),
          make_date(2008 + (n % 10)::int, 1, 1),
          CASE WHEN n % 2 = 0 THEN 'female' ELSE 'male' END,
          'active', ${SEED_TIME}, ${SEED_TIME}
        FROM generate_series(0, ${org.peopleCount - 1}) AS generated(n)
        ON CONFLICT (id) DO NOTHING
      `.execute(trx);

      const householdId = loadUuid(
        sql`'load-household:' || ${orgId} || ':' || n::text`,
      );
      await sql`
        INSERT INTO households (
          id, org_id, name, status, created_at, updated_at
        )
        SELECT
          ${householdId}, ${orgId}, 'Load household ' || lpad(n::text, 5, '0'),
          'active', ${SEED_TIME}, ${SEED_TIME}
        FROM generate_series(0, ${org.peopleCount - 1}) AS generated(n)
        ON CONFLICT (id) DO NOTHING
      `.execute(trx);

      const householdMemberId = loadUuid(
        sql`'load-household-member:' || ${orgId} || ':' || n::text`,
      );
      await sql`
        INSERT INTO household_members (
          id, org_id, household_id, person_id, role,
          is_primary_contact, receives_communications,
          financially_responsible, can_pick_up, created_at, updated_at
        )
        SELECT
          ${householdMemberId}, ${orgId}, ${householdId}, ${peopleId}, 'athlete',
          false, true, false, false, ${SEED_TIME}, ${SEED_TIME}
        FROM generate_series(0, ${org.peopleCount - 1}) AS generated(n)
        ON CONFLICT (id) DO NOTHING
      `.execute(trx);

      if (isRegistrationOrg) {
        const familyLinkId = loadUuid(
          sql`'load-family-link:' || ${orgId} || ':' || n::text`,
        );
        const familyPersonId = loadUuid(
          sql`'load-person:' || ${orgId} || ':' || n::text`,
        );
        const guardianAccountId = loadUuid(
          sql`'load-family-account:' || n::text`,
        );
        await sql`
          INSERT INTO person_account_links (
            id, org_id, person_id, account_id, relationship,
            verified_at, created_at, updated_at
          )
          SELECT
            ${familyLinkId}, ${orgId}, ${familyPersonId},
            ${guardianAccountId}, 'guardian', ${SEED_TIME}, ${SEED_TIME}, ${SEED_TIME}
          FROM generate_series(0, ${LOAD_FAMILY_ACCOUNTS - 1}) AS generated(n)
          ON CONFLICT (id) DO NOTHING
        `.execute(trx);

        const coachLinkId = loadUuid(
          sql`'load-coach-link:' || ${orgId} || ':' || n::text`,
        );
        const coachPersonId = loadUuid(
          sql`'load-person:' || ${orgId} || ':' || (19500 + n)::text`,
        );
        const loadCoachAccountId = loadUuid(
          sql`'load-coach-account:' || n::text`,
        );
        await sql`
          INSERT INTO person_account_links (
            id, org_id, person_id, account_id, relationship,
            verified_at, created_at, updated_at
          )
          SELECT
            ${coachLinkId}, ${orgId}, ${coachPersonId},
            ${loadCoachAccountId}, 'self', ${SEED_TIME}, ${SEED_TIME}, ${SEED_TIME}
          FROM generate_series(0, ${LOAD_COACH_ACCOUNTS - 1}) AS generated(n)
          ON CONFLICT (id) DO NOTHING
        `.execute(trx);

        const preferenceId = loadUuid(
          sql`'load-email-opt-in:' || ${orgId} || ':' || n::text`,
        );
        await sql`
          INSERT INTO communication_preferences (
            id, org_id, account_id, category, channel, enabled,
            created_at, updated_at
          )
          SELECT
            ${preferenceId}, ${orgId}, ${guardianAccountId},
            'marketing', 'email', true, ${SEED_TIME}, ${SEED_TIME}
          FROM generate_series(0, ${LOAD_FAMILY_ACCOUNTS - 1}) AS generated(n)
          ON CONFLICT (id) DO NOTHING
        `.execute(trx);

        const capacityCounterValues = spikeOfferings.map((offering, index) => ({
          id: stableId(`load-capacity-counter:${org.slug}:${String(index)}`),
          org_id: orgId,
          subject_type: 'offering',
          subject_id: offering.id,
          capacity: 100,
          confirmed: 0,
          held: 0,
          created_at: SEED_TIME,
          updated_at: SEED_TIME,
        }));
        await trx
          .insertInto('capacity_counters')
          .values(capacityCounterValues)
          .onConflict((oc) => oc.column('id').doNothing())
          .execute();

        const teamSeasonRows = sql.join(
          teamSeasonIds.map((id, index) => sql`(${index}::int, ${id}::uuid)`),
          sql`, `,
        );
        await sql`
          WITH team_map(team_index, team_season_id) AS (
            VALUES ${teamSeasonRows}
          ), generated AS (
            SELECT n, (n / 50)::int AS team_index
            FROM generate_series(0, ${LOAD_COACH_ACCOUNTS - 1}) AS staff(n)
          )
          INSERT INTO team_staff (
            id, org_id, team_season_id, person_id, role, status, added_by,
            created_at, updated_at
          )
          SELECT
            ${loadUuid(sql`'load-team-staff:' || ${orgId} || ':' || n::text`)},
            ${orgId}, team_map.team_season_id,
            ${loadUuid(sql`'load-person:' || ${orgId} || ':' || (19500 + n)::text`)},
            CASE WHEN n % 50 = 0 THEN 'head_coach' ELSE 'assistant_coach' END,
            'active', ${adminId}, ${SEED_TIME}, ${SEED_TIME}
          FROM generated
          JOIN team_map USING (team_index)
          ON CONFLICT (id) DO NOTHING
        `.execute(trx);
      }

      const programMapValues = sql.join(
        standardOfferings.map(
          (offering, index) =>
            sql`(${index}::int, ${programs[index]?.id ?? ''}::uuid, ${divisions[index]?.id ?? ''}::uuid, ${offering.id}::uuid)`,
        ),
        sql`, `,
      );
      const teamMapValues =
        isRegistrationOrg && teamSeasonIds.length > 0
          ? sql.join(
              teamSeasonIds.map(
                (id, index) => sql`(${index}::int, ${id}::uuid)`,
              ),
              sql`, `,
            )
          : sql`(-1::int, NULL::uuid)`;
      const teamJoin = isRegistrationOrg
        ? sql`LEFT JOIN team_map ON team_map.team_index = source.person_index % 10 AND source.program_index = 0`
        : sql`LEFT JOIN team_map ON false`;
      const teamValue = isRegistrationOrg
        ? sql`team_map.team_season_id`
        : sql`NULL::uuid`;
      await sql`
        WITH program_map(program_index, program_id, division_id, offering_id) AS (
          VALUES ${programMapValues}
        ), team_map(team_index, team_season_id) AS (
          VALUES ${teamMapValues}
        ), source AS (
          SELECT
            program_map.program_index,
            program_map.program_id,
            program_map.division_id,
            program_map.offering_id,
            n,
            ((n + program_map.program_index * ${LOAD_REGISTRATIONS_PER_PROGRAM}) % ${org.peopleCount})::int AS person_index
          FROM program_map
          CROSS JOIN generate_series(0, ${LOAD_REGISTRATIONS_PER_PROGRAM - 1}) AS generated(n)
        )
        INSERT INTO registrations (
          id, org_id, program_id, division_id, offering_id,
          person_id, household_id, registered_by_account_id,
          source, status, team_season_id, created_at, updated_at
        )
        SELECT
          ${loadUuid(sql`'load-registration:' || ${orgId} || ':' || source.program_index::text || ':' || source.n::text`)},
          ${orgId}, source.program_id, source.division_id, source.offering_id,
          ${loadUuid(sql`'load-person:' || ${orgId} || ':' || source.person_index::text`)},
          ${loadUuid(sql`'load-household:' || ${orgId} || ':' || source.person_index::text`)},
          ${adminId}, 'online', 'confirmed', ${teamValue}, ${SEED_TIME}, ${SEED_TIME}
        FROM source
        ${teamJoin}
        ON CONFLICT (id) DO NOTHING
      `.execute(trx);

      if (isRegistrationOrg) {
        const rosterTeamRows = sql.join(
          teamSeasonIds.map((id, index) => sql`(${index}::int, ${id}::uuid)`),
          sql`, `,
        );
        await sql`
          WITH team_map(team_index, team_season_id) AS (
            VALUES ${rosterTeamRows}
          ), generated AS (
            SELECT n, n % 10 AS team_index, n / 10 + 1 AS jersey
            FROM generate_series(0, ${LOAD_REGISTRATIONS_PER_PROGRAM - 1}) AS players(n)
          )
          INSERT INTO roster_entries (
            id, org_id, team_season_id, person_id, registration_id,
            kind, jersey_number, status, joined_on, created_at, updated_at
          )
          SELECT
            ${loadUuid(sql`'load-roster:' || ${orgId} || ':' || n::text`)},
            ${orgId}, team_map.team_season_id,
            ${loadUuid(sql`'load-person:' || ${orgId} || ':' || n::text`)},
            ${loadUuid(sql`'load-registration:' || ${orgId} || ':0:' || n::text`)},
            'rostered', jersey::text, 'active', '2027-01-01', ${SEED_TIME}, ${SEED_TIME}
          FROM generated
          JOIN team_map USING (team_index)
          ON CONFLICT (id) DO NOTHING
        `.execute(trx);
      }

      const eventId = loadUuid(
        sql`'load-event:' || ${orgId} || ':' || event_index::text`,
      );
      await sql`
        WITH generated AS (
          SELECT n AS event_index
          FROM generate_series(0, ${LOAD_ATTENDANCE_EVENTS_PER_ORG - 1}) AS events(n)
        )
        INSERT INTO events (
          id, org_id, program_id, division_id, kind, title,
          starts_at, ends_at, timezone, status, published,
          created_at, updated_at
        )
        SELECT
          ${eventId}, ${orgId}, ${programZero.id}, ${divisionZero.id},
          'practice', 'Load practice ' || (event_index + 1)::text,
          '2027-03-01T15:00:00Z'::timestamptz + event_index * interval '7 days',
          '2027-03-01T16:30:00Z'::timestamptz + event_index * interval '7 days',
          'America/Chicago', 'scheduled', true, ${SEED_TIME}, ${SEED_TIME}
        FROM generated
        ON CONFLICT (id) DO NOTHING
      `.execute(trx);

      if (isRegistrationOrg) {
        const homeTeamRows = sql.join(
          teamSeasonIds.map((id, index) => sql`(${index}::int, ${id}::uuid)`),
          sql`, `,
        );
        await sql`
          WITH team_map(team_index, team_season_id) AS (
            VALUES ${homeTeamRows}
          ), generated AS (
            SELECT n AS event_index, n % ${teamCount} AS home_index,
              (n + 1) % ${teamCount} AS away_index
            FROM generate_series(0, ${LOAD_ATTENDANCE_EVENTS_PER_ORG - 1}) AS events(n)
          ), contests AS (
            INSERT INTO contests (
              id, org_id, event_id, sport_profile_id, profile_version,
              format, stage, counts_for_standings, status, created_at, updated_at
            )
            SELECT
              ${loadUuid(sql`'load-contest:' || ${orgId} || ':' || event_index::text`)},
              ${orgId}, ${eventId}, ${sportId}, 1,
              'head_to_head_score', 'regular', true, 'scheduled', ${SEED_TIME}, ${SEED_TIME}
            FROM generated
            ON CONFLICT (id) DO NOTHING
            RETURNING id
          )
          INSERT INTO contest_participants (
            id, org_id, contest_id, team_season_id, side, created_at, updated_at
          )
          SELECT
            ${loadUuid(sql`'load-contest-participant:' || ${orgId} || ':' || event_index::text || ':home'`)},
            ${orgId}::uuid,
            ${loadUuid(sql`'load-contest:' || ${orgId} || ':' || event_index::text`)},
            home_team.team_season_id, 'home', ${SEED_TIME}::timestamptz, ${SEED_TIME}::timestamptz
          FROM generated
          JOIN team_map AS home_team ON home_team.team_index = generated.home_index
          UNION ALL
          SELECT
            ${loadUuid(sql`'load-contest-participant:' || ${orgId} || ':' || event_index::text || ':away'`)},
            ${orgId}::uuid,
            ${loadUuid(sql`'load-contest:' || ${orgId} || ':' || event_index::text`)},
            away_team.team_season_id, 'away', ${SEED_TIME}::timestamptz, ${SEED_TIME}::timestamptz
          FROM generated
          JOIN team_map AS away_team ON away_team.team_index = generated.away_index
          ON CONFLICT (id) DO NOTHING
        `.execute(trx);
      }

      const attendanceId = loadUuid(
        sql`'load-attendance:' || ${orgId} || ':' || event_index::text || ':' || attendee_index::text`,
      );
      const attendanceEventId = loadUuid(
        sql`'load-event:' || ${orgId} || ':' || event_index::text`,
      );
      const attendancePersonId = loadUuid(
        sql`'load-person:' || ${orgId} || ':' || person_index::text`,
      );
      await sql`
        WITH generated AS (
          SELECT
            events.event_index,
            people.attendee_index,
            ((people.attendee_index + events.event_index * ${LOAD_ATTENDANCE_PEOPLE_PER_EVENT}) % ${org.peopleCount})::int AS person_index
          FROM generate_series(0, ${LOAD_ATTENDANCE_EVENTS_PER_ORG - 1}) AS events(event_index)
          CROSS JOIN generate_series(0, ${LOAD_ATTENDANCE_PEOPLE_PER_EVENT - 1}) AS people(attendee_index)
        )
        INSERT INTO attendance (
          id, org_id, event_id, person_id, rsvp, status,
          checked_in_at, created_at, updated_at
        )
        SELECT
          ${attendanceId}, ${orgId}, ${attendanceEventId}, ${attendancePersonId},
          'yes', CASE WHEN attendee_index % 10 = 0 THEN 'late' ELSE 'present' END,
          '2027-03-01T15:05:00Z'::timestamptz + event_index * interval '7 days',
          ${SEED_TIME}, ${SEED_TIME}
        FROM generated
        ON CONFLICT (id) DO NOTHING
      `.execute(trx);
    });
  }
}
