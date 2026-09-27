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
