import { z } from 'zod';

const conversationKindSchema = z.enum([
  'team',
  'team_staff',
  'announcement',
  'group',
  'direct',
]);
export const conversationCreateSchema = z.strictObject({
  kind: conversationKindSchema,
  teamSeasonId: z.uuid().nullable().optional(),
  title: z.string().trim().max(120).nullable().optional(),
  accountIds: z.array(z.uuid()).max(100).default([]),
});
export const chatMessageCreateSchema = z.strictObject({
  body: z.string().trim().min(1).max(5000),
  attachments: z.array(z.uuid()).max(5).default([]),
});
export const chatMessageEditSchema = z.strictObject({
  body: z.string().trim().min(1).max(5000),
  expectedVersion: z.number().int().positive(),
});
export const chatReportSchema = z.strictObject({
  reason: z.enum([
    'safesport_concern',
    'harassment',
    'inappropriate_content',
    'other',
  ]),
  details: z.string().trim().min(5).max(2000).optional(),
});
export const chatModerationUpdateSchema = z.strictObject({
  status: z.enum(['reviewing', 'resolved', 'dismissed']),
  expectedVersion: z.number().int().positive(),
});
export const chatMessageSchema = z.strictObject({
  id: z.uuid(),
  conversationId: z.uuid(),
  authorAccountId: z.uuid(),
  authorName: z.string(),
  body: z.string(),
  attachments: z.array(z.strictObject({ fileId: z.uuid(), mime: z.string() })),
  editedAt: z.iso.datetime({ offset: true }).nullable(),
  deletedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  readByCount: z.number().int().nonnegative(),
  version: z.number().int().positive(),
});
export const conversationSchema = z.strictObject({
  id: z.uuid(),
  kind: conversationKindSchema,
  title: z.string().nullable(),
  teamSeasonId: z.uuid().nullable(),
  guardianCopied: z.boolean(),
  muted: z.boolean(),
  unreadCount: z.number().int().nonnegative(),
  lastMessageAt: z.iso.datetime({ offset: true }).nullable(),
});
export const conversationListSchema = z.strictObject({
  items: z.array(conversationSchema),
});
export const chatMemberOptionsSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      accountId: z.uuid(),
      label: z.string(),
    }),
  ),
});
export const chatAttachmentCapabilitiesSchema = z.strictObject({
  canUpload: z.boolean(),
  canDownload: z.boolean(),
});
export const chatMessageListSchema = z.strictObject({
  items: z.array(chatMessageSchema),
  nextCursor: z.string().nullable(),
});
export const chatReportResponseSchema = z.strictObject({
  id: z.uuid(),
  incidentReportId: z.uuid(),
  status: z.literal('open'),
});
export const chatModerationListSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      reportId: z.uuid(),
      incidentReportId: z.uuid(),
      messageId: z.uuid(),
      conversationId: z.uuid(),
      reportedBy: z.uuid(),
      reason: z.string(),
      status: z.enum(['open', 'reviewing', 'resolved', 'dismissed']),
      createdAt: z.iso.datetime({ offset: true }),
      version: z.number().int().positive(),
    }),
  ),
});
