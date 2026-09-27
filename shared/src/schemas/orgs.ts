import { z } from 'zod';

const orgKindSchema = z.enum([
  'club',
  'league',
  'association',
  'academy',
  'school',
  'parks_rec',
  'tournament_operator',
  'other',
]);

const reservedOrgSlugs = new Set([
  'admin',
  'api',
  'app',
  'assets',
  'auth',
  'billing',
  'docs',
  'healthz',
  'help',
  'login',
  'mail',
  'me',
  'o',
  'payments',
  'platform',
  'register',
  'sign-up',
  'start',
  'static',
  'status',
  'support',
  'www',
]);

export const orgSlugSchema = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .refine(
    (value) => !reservedOrgSlugs.has(value),
    'Reserved organization slug',
  );

const orgAddressSchema = z.strictObject({
  line1: z.string().trim().min(1).max(160),
  line2: z.string().trim().max(160).optional(),
  city: z.string().trim().min(1).max(100),
  region: z
    .string()
    .trim()
    .length(2)
    .regex(/^[A-Z]{2}$/),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}(?:-\d{4})?$/),
  country: z.literal('US'),
});

export const createOrgSchema = z.strictObject({
  name: z.string().trim().min(2).max(160),
  slug: orgSlugSchema,
  kind: orgKindSchema,
  timezone: z.string().refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }),
  address: orgAddressSchema,
  sportKeys: z
    .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
    .min(1)
    .max(10)
    .refine((keys) => new Set(keys).size === keys.length, 'Duplicate sport'),
});

export type CreateOrgInput = z.infer<typeof createOrgSchema>;

export const orgSlugAvailabilitySchema = z.strictObject({
  slug: orgSlugSchema,
  available: z.boolean(),
});

export const sportTemplateCatalogSchema = z.array(
  z.strictObject({
    key: z.string(),
    name: z.string(),
  }),
);

export const createOrgResponseSchema = z.strictObject({
  id: z.uuid(),
  slug: orgSlugSchema,
  status: z.literal('onboarding'),
});

export const orgCredentialSchema = z.strictObject({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  verification: z.enum([
    'document_upload',
    'attestation',
    'provider',
    'manual_staff',
  ]),
  validityMonths: z.number().int().min(1).max(120),
  blocksActivation: z.boolean(),
  active: z.boolean(),
  version: z.number().int().positive(),
});

export const orgCredentialsResponseSchema = z.array(orgCredentialSchema);

export const updateOrgCredentialSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  validityMonths: orgCredentialSchema.shape.validityMonths,
  blocksActivation: z.boolean(),
  active: z.boolean(),
  version: z.number().int().positive(),
});

const orgRoleSchema = z.enum([
  'owner',
  'admin',
  'registrar',
  'finance',
  'scheduler',
  'compliance',
  'communications',
  'director',
  'evaluator',
  'volunteer_coordinator',
  'reporter',
]);

export const updateOrgMemberRolesSchema = z.strictObject({
  roles: z
    .array(orgRoleSchema)
    .min(1)
    .max(11)
    .refine((roles) => new Set(roles).size === roles.length, 'Duplicate role'),
  expectedVersion: z.number().int().positive(),
});

export const orgMemberRolesResponseSchema = z.strictObject({
  accountId: z.uuid(),
  roles: z.array(orgRoleSchema),
  pendingMfa: z.boolean(),
  version: z.number().int().positive(),
});

export const orgInvitationSchema = z
  .strictObject({
    email: z.email().max(254),
    roles: z
      .array(orgRoleSchema)
      .min(1)
      .max(11)
      .refine(
        (roles) => new Set(roles).size === roles.length,
        'Duplicate role',
      ),
    scopeType: z.enum(['org', 'season', 'program', 'division', 'team_season']),
    scopeId: z.uuid().nullable(),
  })
  .superRefine((input, context) => {
    if ((input.scopeType === 'org') !== (input.scopeId === null)) {
      context.addIssue({
        code: 'custom',
        path: ['scopeId'],
        message: 'Organization scope has no id; narrower scopes require one',
      });
    }
    if (input.roles.includes('owner')) {
      context.addIssue({
        code: 'custom',
        path: ['roles'],
        message: 'Ownership requires a recipient-accepted transfer',
      });
    }
  });

export const orgInvitationResponseSchema = z.strictObject({
  id: z.uuid(),
  email: z.email(),
  expiresAt: z.iso.datetime(),
});

export const acceptOrgInvitationSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const acceptedOrgInvitationResponseSchema = z.strictObject({
  orgId: z.uuid(),
  accountId: z.uuid(),
  roles: z.array(orgRoleSchema),
  pendingMfa: z.boolean(),
});
