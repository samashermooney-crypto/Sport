import { z } from 'zod';

const safeHrefSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(
    (value) =>
      (value.startsWith('/') && !value.startsWith('//')) ||
      /^https:\/\//i.test(value),
    {
      message: 'Links must be relative paths or secure HTTPS URLs',
    },
  );

export const websiteBlockSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('heading'),
    text: z.string().trim().min(1).max(180),
    level: z.union([z.literal(2), z.literal(3)]),
  }),
  z.strictObject({
    type: z.literal('paragraph'),
    text: z.string().trim().min(1).max(4000),
  }),
  z.strictObject({
    type: z.literal('link'),
    label: z.string().trim().min(1).max(100),
    href: safeHrefSchema,
  }),
]);

export const websiteSeoSchema = z.strictObject({
  title: z.string().trim().max(70).default(''),
  description: z.string().trim().max(160).default(''),
  canonicalPath: z
    .string()
    .trim()
    .max(300)
    .refine(
      (value) =>
        value === '' ||
        (value.startsWith('/') &&
          !value.startsWith('//') &&
          !value.includes('..')),
    )
    .default(''),
  openGraphImageUrl: z
    .url()
    .refine((value) => value.startsWith('https://'))
    .optional(),
});
export type WebsiteSeo = z.infer<typeof websiteSeoSchema>;

export const websitePageSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/);

export const websitePageBodySchema = z.strictObject({
  slug: websitePageSlugSchema,
  title: z.string().trim().min(1).max(180),
  blocks: z.array(websiteBlockSchema).max(100),
  seo: websiteSeoSchema,
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  expectedVersion: z.number().int().positive().optional(),
});

export const websitePageSchema = z.strictObject({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  blocks: z.array(websiteBlockSchema),
  seo: websiteSeoSchema,
  status: z.enum(['draft', 'published', 'archived']),
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type WebsitePage = z.infer<typeof websitePageSchema>;

export const websitePageListSchema = z.strictObject({
  items: z.array(websitePageSchema),
});

export const websiteMenuItemSchema = z.strictObject({
  label: z.string().trim().min(1).max(80),
  href: safeHrefSchema,
});

export const websitePublicPageSchema = z.strictObject({
  organization: z.strictObject({
    name: z.string(),
    slug: z.string(),
    locale: z.enum(['en', 'es']),
  }),
  theme: z.strictObject({
    primary: z.string().regex(/^#[0-9a-f]{6}$/i),
    secondary: z.string().regex(/^#[0-9a-f]{6}$/i),
  }),
  robotsPolicy: z.enum(['index', 'noindex']),
  page: z.strictObject({
    slug: z.string(),
    title: z.string(),
    blocks: z.array(websiteBlockSchema),
    seo: websiteSeoSchema,
  }),
  navigation: z.array(websiteMenuItemSchema),
  footerNavigation: z.array(websiteMenuItemSchema),
});

export const websitePublicFacilitiesSchema = z.strictObject({
  organization: z.strictObject({
    name: z.string(),
    slug: z.string(),
    locale: z.enum(['en', 'es']),
  }),
  theme: z.strictObject({
    primary: z.string().regex(/^#[0-9a-f]{6}$/i),
    secondary: z.string().regex(/^#[0-9a-f]{6}$/i),
  }),
  robotsPolicy: z.enum(['index', 'noindex']),
  navigation: z.array(websiteMenuItemSchema),
  footerNavigation: z.array(websiteMenuItemSchema),
  facilities: z.array(
    z.strictObject({
      id: z.uuid(),
      name: z.string(),
      address: z.record(z.string(), z.string()).nullable(),
      mapUrl: z
        .url()
        .refine((value) =>
          ['http:', 'https:'].includes(new URL(value).protocol),
        )
        .nullable(),
    }),
  ),
});

const websiteNewsSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const websiteNewsBodySchema = z.strictObject({
  slug: websiteNewsSlugSchema,
  title: z.string().trim().min(1).max(180),
  excerpt: z.string().trim().max(320).nullable(),
  bodyText: z.string().trim().min(1).max(12000),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  expectedVersion: z.number().int().positive().optional(),
});

export const websiteNewsPostSchema = z.strictObject({
  id: z.uuid(),
  slug: z.string(),
  title: z.string(),
  excerpt: z.string().nullable(),
  bodyText: z.string(),
  status: z.enum(['draft', 'published', 'archived']),
  publishedAt: z.iso.datetime({ offset: true }).nullable(),
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime({ offset: true }),
});

export const websiteNewsListSchema = z.strictObject({
  items: z.array(websiteNewsPostSchema),
});

export const websiteNewsSaveResponseSchema = z.strictObject({
  post: websiteNewsPostSchema,
});

export const websitePublicNewsSchema = z.strictObject({
  organization: z.strictObject({
    name: z.string(),
    slug: z.string(),
    locale: z.enum(['en', 'es']),
  }),
  theme: z.strictObject({
    primary: z.string().regex(/^#[0-9a-f]{6}$/i),
    secondary: z.string().regex(/^#[0-9a-f]{6}$/i),
  }),
  robotsPolicy: z.enum(['index', 'noindex']),
  navigation: z.array(websiteMenuItemSchema),
  footerNavigation: z.array(websiteMenuItemSchema),
  posts: z.array(
    websiteNewsPostSchema.pick({
      slug: true,
      title: true,
      excerpt: true,
      bodyText: true,
      publishedAt: true,
    }),
  ),
});

export const websiteSettingsBodySchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  published: z.boolean(),
  robotsPolicy: z.enum(['index', 'noindex']),
  theme: z.strictObject({
    primary: z.string().regex(/^#[0-9a-f]{6}$/i),
    secondary: z.string().regex(/^#[0-9a-f]{6}$/i),
  }),
  seo: websiteSeoSchema,
  contactInboxEmail: z.email().nullable(),
});

export const websiteSettingsSchema = z.strictObject({
  version: z.number().int().nonnegative(),
  published: z.boolean(),
  robotsPolicy: z.enum(['index', 'noindex']),
  theme: z.strictObject({
    primary: z.string().regex(/^#[0-9a-f]{6}$/i),
    secondary: z.string().regex(/^#[0-9a-f]{6}$/i),
  }),
  seo: websiteSeoSchema,
  contactInboxEmail: z.email().nullable(),
});

export const websiteMenuSchema = z.strictObject({
  location: z.enum(['header', 'footer']),
  items: z.array(websiteMenuItemSchema).max(20),
  version: z.number().int().nonnegative(),
});

export const websiteMenuListSchema = z.strictObject({
  items: z.array(websiteMenuSchema),
});

export const websiteMenuBodySchema = z.strictObject({
  location: z.enum(['header', 'footer']),
  items: z.array(websiteMenuItemSchema).max(20),
  expectedVersion: z.number().int().nonnegative(),
});

export const websiteSettingsResponseSchema = z.strictObject({
  settings: websiteSettingsSchema,
});

export const websiteContactSubmissionBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  subject: z.string().trim().max(160).default(''),
  body: z.string().trim().min(1).max(5000),
  captchaToken: z.string().trim().min(1).max(2048),
});

export const websiteContactSubmissionSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  email: z.email(),
  subject: z.string(),
  body: z.string(),
  status: z.enum(['new', 'read', 'archived']),
  createdAt: z.iso.datetime({ offset: true }),
});
export type WebsiteContactSubmission = z.infer<
  typeof websiteContactSubmissionSchema
>;

export const websiteContactSubmissionListSchema = z.strictObject({
  items: z.array(websiteContactSubmissionSchema),
});

export const websiteContactSubmissionResponseSchema = z.strictObject({
  received: z.literal(true),
});

export const websiteContactReadResponseSchema = z.strictObject({
  updatedCount: z.number().int().nonnegative(),
});

export const websiteMenuResponseSchema = z.strictObject({
  menu: websiteMenuSchema,
});

export type WebsiteSettings = z.infer<typeof websiteSettingsSchema>;
export type WebsiteMenu = z.infer<typeof websiteMenuSchema>;
export type WebsiteMenuItem = z.infer<typeof websiteMenuItemSchema>;

const websiteDomainHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(4)
  .max(253)
  .regex(
    /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
    'Enter a fully qualified domain name',
  );

export const websiteDomainSchema = z.strictObject({
  id: z.uuid(),
  host: websiteDomainHostSchema,
  status: z.enum(['pending', 'verifying', 'active', 'failed', 'disabled']),
  isPrimary: z.boolean(),
  verificationRecordName: z.string().min(1),
  verificationToken: z.string().nullable(),
  verifiedAt: z.iso.datetime({ offset: true }).nullable(),
  lastCheckedAt: z.iso.datetime({ offset: true }).nullable(),
  statusNote: z.string().nullable(),
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type WebsiteDomain = z.infer<typeof websiteDomainSchema>;

export const websiteDomainListSchema = z.strictObject({
  items: z.array(websiteDomainSchema),
});

export const websiteDomainCreateSchema = z.strictObject({
  host: websiteDomainHostSchema,
});

export const websiteDomainResponseSchema = z.strictObject({
  domain: websiteDomainSchema,
});

export const websiteEmbedConfigSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('program_list'),
    title: z.string().trim().min(1).max(80).default('Programs'),
    limit: z.number().int().min(1).max(20).default(10),
  }),
  z.strictObject({
    kind: z.literal('schedule'),
    title: z.string().trim().min(1).max(80).default('Schedule'),
    limit: z.number().int().min(1).max(50).default(20),
    programId: z.uuid().nullable().default(null),
  }),
  z.strictObject({
    kind: z.literal('standings'),
    title: z.string().trim().min(1).max(80).default('Standings'),
    programId: z.uuid(),
  }),
  z.strictObject({
    kind: z.literal('registration_button'),
    label: z.string().trim().min(1).max(80).default('Register'),
    programSlug: websiteNewsSlugSchema,
  }),
]);
export type WebsiteEmbedConfig = z.infer<typeof websiteEmbedConfigSchema>;

export const websiteEmbedSchema = z.strictObject({
  id: z.uuid(),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  config: websiteEmbedConfigSchema,
  version: z.number().int().positive(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type WebsiteEmbed = z.infer<typeof websiteEmbedSchema>;

export const websiteEmbedBodySchema = z.strictObject({
  config: websiteEmbedConfigSchema,
  expectedVersion: z.number().int().positive().optional(),
});

export const websiteEmbedListSchema = z.strictObject({
  items: z.array(websiteEmbedSchema),
});

export const websiteEmbedResponseSchema = z.strictObject({
  embed: websiteEmbedSchema,
});

export const websitePublicEmbedSchema = z.strictObject({
  organization: z.strictObject({ slug: z.string(), name: z.string() }),
  config: websiteEmbedConfigSchema,
  program: z.strictObject({ slug: z.string(), name: z.string() }).nullable(),
  items: z.array(
    z.strictObject({
      label: z.string(),
      href: safeHrefSchema,
      detail: z.string().nullable(),
    }),
  ),
});

export const websiteSaveResponseSchema = z.strictObject({
  page: websitePageSchema,
});

export type WebsiteBlock = z.infer<typeof websiteBlockSchema>;
export type WebsiteNewsPost = z.infer<typeof websiteNewsPostSchema>;
