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

export const websiteMenuResponseSchema = z.strictObject({
  menu: websiteMenuSchema,
});

export type WebsiteSettings = z.infer<typeof websiteSettingsSchema>;
export type WebsiteMenu = z.infer<typeof websiteMenuSchema>;
export type WebsiteMenuItem = z.infer<typeof websiteMenuItemSchema>;

export const websiteSaveResponseSchema = z.strictObject({
  page: websitePageSchema,
});

export type WebsiteBlock = z.infer<typeof websiteBlockSchema>;
export type WebsitePageBody = z.infer<typeof websitePageBodySchema>;
