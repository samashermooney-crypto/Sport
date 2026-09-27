import { z } from 'zod';

import {
  entityIdSchema,
  entityVersionSchema,
  moneyCentsSchema,
  tenantEntitySchema,
} from './base';

export const registrationEntitySchema = tenantEntitySchema.extend({
  programId: entityIdSchema,
  divisionId: entityIdSchema,
  offeringId: entityIdSchema,
  personId: entityIdSchema,
  householdId: entityIdSchema,
  status: z.enum([
    'pending_payment',
    'pending_approval',
    'waitlisted',
    'offered',
    'confirmed',
    'canceled',
    'withdrawn',
    'transferred_out',
  ]),
  source: z.enum(['online', 'staff', 'import', 'offer_acceptance', 'transfer']),
  version: entityVersionSchema,
});

export const eventEntitySchema = tenantEntitySchema.extend({
  kind: z.enum([
    'game',
    'practice',
    'meet',
    'match',
    'bout_session',
    'class_session',
    'evaluation_session',
    'tournament_game',
    'meeting',
    'volunteer_shift',
    'other',
  ]),
  title: z.string().min(1),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  timezone: z.string().min(1),
  status: z.enum(['scheduled', 'postponed', 'canceled', 'completed']),
  published: z.boolean(),
  version: entityVersionSchema,
});

export const contestEntitySchema = tenantEntitySchema.extend({
  eventId: entityIdSchema,
  sportProfileId: entityIdSchema,
  profileVersion: entityVersionSchema,
  format: z.enum([
    'head_to_head_score',
    'head_to_head_sets',
    'head_to_head_bout',
    'multi_timed',
    'multi_measured',
    'judged',
    'placement_only',
  ]),
  stage: z.enum([
    'regular',
    'pool',
    'playoff',
    'championship',
    'consolation',
    'friendly',
    'exhibition',
  ]),
  status: z.enum([
    'scheduled',
    'in_progress',
    'final',
    'forfeit',
    'canceled',
    'abandoned',
  ]),
  version: entityVersionSchema,
});

export const credentialEntitySchema = tenantEntitySchema.extend({
  personId: entityIdSchema,
  credentialTypeId: entityIdSchema,
  status: z.enum([
    'pending_review',
    'verified',
    'rejected',
    'expired',
    'revoked',
  ]),
  issuedOn: z.iso.date().nullable(),
  expiresOn: z.iso.date().nullable(),
  version: entityVersionSchema,
});

export const officialAssignmentEntitySchema = tenantEntitySchema.extend({
  contestId: entityIdSchema,
  personId: entityIdSchema,
  positionKey: z.string().min(1),
  status: z.enum([
    'offered',
    'accepted',
    'declined',
    'confirmed',
    'canceled',
    'no_show',
  ]),
  feeCents: moneyCentsSchema,
  mileageCents: moneyCentsSchema,
  version: entityVersionSchema,
});

export const attendanceEntitySchema = tenantEntitySchema.extend({
  eventId: entityIdSchema,
  personId: entityIdSchema,
  rsvp: z.enum(['yes', 'no', 'maybe', 'none']),
  status: z.enum(['present', 'absent', 'late', 'excused', 'unknown']),
  checkedInAt: z.iso.datetime().nullable(),
  version: entityVersionSchema,
});
