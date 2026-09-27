import { z } from 'zod';

import {
  entityIdSchema,
  entityVersionSchema,
  moneyCentsSchema,
  tenantEntitySchema,
} from './base';

export const programEntitySchema = tenantEntitySchema.extend({
  seasonId: entityIdSchema,
  sportProfileId: entityIdSchema,
  mode: z.enum([
    'league',
    'club',
    'class',
    'camp',
    'clinic',
    'tryout',
    'tournament',
    'event',
    'membership',
  ]),
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  status: z.enum([
    'draft',
    'published',
    'registration_open',
    'registration_closed',
    'in_progress',
    'completed',
    'archived',
  ]),
  visibility: z.enum(['public', 'unlisted', 'private']),
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
  version: entityVersionSchema,
});

export const divisionEntitySchema = tenantEntitySchema.extend({
  programId: entityIdSchema,
  name: z.string().min(1),
  level: z.enum([
    'recreational',
    'developmental',
    'competitive',
    'elite',
    'open',
  ]),
  capacityPlayers: z.number().int().nonnegative().nullable(),
  capacityTeams: z.number().int().nonnegative().nullable(),
  version: entityVersionSchema,
});

export const offeringEntitySchema = tenantEntitySchema.extend({
  programId: entityIdSchema,
  divisionId: entityIdSchema.nullable(),
  name: z.string().min(1),
  registrantRole: z.enum([
    'athlete',
    'coach',
    'volunteer',
    'team_entry',
    'official',
  ]),
  priceCents: moneyCentsSchema,
  capacity: z.number().int().nonnegative().nullable(),
  visibility: z.enum(['public', 'invite_only', 'staff_only']),
  active: z.boolean(),
  version: entityVersionSchema,
});

export const teamSeasonEntitySchema = tenantEntitySchema.extend({
  teamId: entityIdSchema,
  programId: entityIdSchema,
  divisionId: entityIdSchema,
  status: z.enum(['forming', 'active', 'completed', 'withdrawn']),
  rosterLimit: z.number().int().nonnegative().nullable(),
  version: entityVersionSchema,
});
