import { z } from 'zod';

export const deliveryChannelSchema = z.enum(['email', 'sms', 'push', 'in_app']);
export const communicationCategorySchema = z.enum([
  'operational',
  'announcement',
  'marketing',
  'emergency',
]);
export const audienceRoleSchema = z.enum([
  'athletes_guardians',
  'coaches',
  'officials',
  'volunteers',
  'board',
]);
const selectorSetSchema = z.strictObject({
  personIds: z.array(z.uuid()).max(500).optional(),
  teamSeasonIds: z.array(z.uuid()).max(200).optional(),
  programIds: z.array(z.uuid()).max(200).optional(),
  roles: z.array(audienceRoleSchema).max(5).optional(),
});
const hasSelector = (value: z.infer<typeof selectorSetSchema>) =>
  Boolean(
    value.personIds?.length ||
    value.teamSeasonIds?.length ||
    value.programIds?.length ||
    value.roles?.length,
  );
export const audienceSpecSchema = z
  .strictObject({
    include: selectorSetSchema,
    exclude: selectorSetSchema.default({}),
  })
  .refine((value) => hasSelector(value.include), {
    message: 'Choose at least one audience selector',
    path: ['include'],
  });
export type AudienceSpec = z.infer<typeof audienceSpecSchema>;

export const localeContentSchema = z.strictObject({
  subject: z.string().max(200).default(''),
  bodyHtml: z.string().max(100_000).default(''),
  bodyText: z.string().max(30_000).default(''),
  smsText: z.string().max(1_600).default(''),
  pushText: z.string().max(500).default(''),
});
export const localeVariantsSchema = z.strictObject({
  en: localeContentSchema,
  es: localeContentSchema,
});

export const campaignDraftSchema = z
  .strictObject({
    channels: z.array(deliveryChannelSchema).min(1).max(4),
    category: communicationCategorySchema,
    audience: audienceSpecSchema,
    subject: z.string().max(200).default(''),
    bodyHtml: z.string().max(100_000).default(''),
    bodyText: z.string().max(30_000).default(''),
    smsText: z.string().max(1_600).default(''),
    pushText: z.string().max(500).default(''),
    localeVariants: localeVariantsSchema,
  })
  .refine((value) => new Set(value.channels).size === value.channels.length, {
    message: 'Delivery channels must be unique',
    path: ['channels'],
  });
export const campaignUpdateSchema = campaignDraftSchema.extend({
  expectedVersion: z.number().int().positive(),
});
export const scheduleCampaignSchema = z.strictObject({
  scheduledFor: z.iso.datetime({ offset: true }),
  expectedVersion: z.number().int().positive(),
});
export const sendCampaignSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  confirmEmergency: z.literal(true).optional(),
  confirmRecipientCounts: z
    .record(deliveryChannelSchema, z.number().int().nonnegative())
    .optional(),
});
export const smsConsentSchema = z.strictObject({
  phoneE164: z.string().regex(/^\+[1-9]\d{7,14}$/),
  accepted: z.literal(true),
  version: z.string().min(1).max(40),
});
export const senderIdentitySchema = z.strictObject({
  displayName: z.string().trim().min(1).max(120).nullable(),
  replyTo: z.email().nullable(),
  smsComplianceText: z.string().trim().max(320).nullable(),
  expectedVersion: z.number().int().nonnegative(),
});
export const verificationTokenSchema = z.strictObject({
  token: z.string().min(32).max(256),
});

export const campaignSummarySchema = z.strictObject({
  id: z.uuid(),
  status: z.enum([
    'draft',
    'scheduled',
    'sending',
    'sent',
    'canceled',
    'failed',
  ]),
  category: communicationCategorySchema,
  channels: z.array(deliveryChannelSchema),
  subject: z.string().nullable(),
  scheduledFor: z.iso.datetime({ offset: true }).nullable(),
  sentAt: z.iso.datetime({ offset: true }).nullable(),
  resolvedRecipientCount: z.number().int().nonnegative().nullable(),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
});
export const campaignDetailSchema = campaignSummarySchema.extend({
  draft: campaignDraftSchema,
});
export const campaignListSchema = z.strictObject({
  items: z.array(campaignSummarySchema),
});
export const audienceOptionsSchema = z.strictObject({
  people: z.array(z.strictObject({ id: z.uuid(), label: z.string() })),
  teams: z.array(z.strictObject({ id: z.uuid(), label: z.string() })),
  programs: z.array(z.strictObject({ id: z.uuid(), label: z.string() })),
});
export const campaignPreviewSchema = z.strictObject({
  recipientCount: z.number().int().nonnegative(),
  counts: z.record(deliveryChannelSchema, z.number().int().nonnegative()),
  recipients: z
    .array(
      z.strictObject({
        displayName: z.string(),
        locale: z.enum(['en', 'es']),
        aboutPersonId: z.uuid().nullable(),
        channels: z.array(deliveryChannelSchema),
      }),
    )
    .max(50),
});
export const campaignStatsSchema = z.strictObject({
  id: z.uuid(),
  status: campaignSummarySchema.shape.status,
  counts: z.record(
    deliveryChannelSchema,
    z.record(z.string(), z.number().int().nonnegative()),
  ),
});
export const smsConsentResponseSchema = z.strictObject({
  accepted: z.boolean(),
  phoneE164: z.string().nullable(),
  acceptedAt: z.iso.datetime({ offset: true }).nullable(),
  locale: z.enum(['en', 'es']).nullable(),
});
export const senderIdentityResponseSchema = z.strictObject({
  displayName: z.string().nullable(),
  replyTo: z.email().nullable(),
  replyToVerified: z.boolean(),
  smsComplianceText: z.string().nullable(),
  version: z.number().int().nonnegative(),
});
export const personCommunicationHistorySchema = z.strictObject({
  items: z.array(
    z.strictObject({
      id: z.uuid(),
      campaignId: z.uuid().nullable(),
      title: z.string(),
      channel: deliveryChannelSchema,
      status: z.string(),
      recipientAccountId: z.uuid(),
      createdAt: z.iso.datetime({ offset: true }),
      sentAt: z.iso.datetime({ offset: true }).nullable(),
      deliveredAt: z.iso.datetime({ offset: true }).nullable(),
    }),
  ),
});

export const audienceRoleLabels = {
  athletes_guardians: 'Athletes and guardians',
  coaches: 'Coaches and team staff',
  officials: 'Officials',
  volunteers: 'Volunteers',
  board: 'Organization owners and administrators',
} as const;

function template(
  category: CommunicationCategory,
  en: { title: string; body: string },
  es: { title: string; body: string },
  options: {
    defaultChannels?: readonly DeliveryChannel[];
    optIn?: boolean;
  } = {},
) {
  return {
    category,
    preferenceKey: category,
    defaultChannels:
      options.defaultChannels ?? (['in_app', 'email', 'push'] as const),
    marketingOptInRequired: options.optIn ?? false,
    en: { ...en, sms: en.body.slice(0, 150), push: en.body.slice(0, 110) },
    es: { ...es, sms: es.body.slice(0, 150), push: es.body.slice(0, 110) },
  } as const;
}

export const phase10NotificationTemplates = {
  'account.security': template(
    'operational',
    {
      title: 'Account security',
      body: 'There is an update to your account security.',
    },
    {
      title: 'Seguridad de la cuenta',
      body: 'Hay una actualización de seguridad en tu cuenta.',
    },
    { defaultChannels: ['in_app', 'email'] },
  ),
  'registration.confirmed': template(
    'operational',
    {
      title: 'Registration confirmed',
      body: 'Your registration is confirmed.',
    },
    {
      title: 'Inscripción confirmada',
      body: 'Tu inscripción está confirmada.',
    },
  ),
  'registration.waitlisted': template(
    'operational',
    { title: 'Waitlist update', body: 'Your registration is on the waitlist.' },
    {
      title: 'Actualización de lista de espera',
      body: 'Tu inscripción está en la lista de espera.',
    },
  ),
  'registration.offered': template(
    'operational',
    {
      title: 'Registration offer',
      body: 'A place is available for your registration.',
    },
    {
      title: 'Oferta de inscripción',
      body: 'Hay un lugar disponible para tu inscripción.',
    },
  ),
  'registration.approved': template(
    'operational',
    {
      title: 'Registration approved',
      body: 'Your registration has been approved.',
    },
    { title: 'Inscripción aprobada', body: 'Tu inscripción fue aprobada.' },
  ),
  'registration.declined': template(
    'operational',
    {
      title: 'Registration update',
      body: 'There is an update to your registration.',
    },
    {
      title: 'Actualización de inscripción',
      body: 'Hay una actualización de tu inscripción.',
    },
  ),
  'registration.canceled': template(
    'operational',
    { title: 'Registration canceled', body: 'Your registration was canceled.' },
    { title: 'Inscripción cancelada', body: 'Tu inscripción fue cancelada.' },
  ),
  'registration.transferred': template(
    'operational',
    {
      title: 'Registration transferred',
      body: 'Your registration was transferred.',
    },
    {
      title: 'Inscripción transferida',
      body: 'Tu inscripción fue transferida.',
    },
  ),
  'checkout.abandoned': template(
    'operational',
    {
      title: 'Registration checkout',
      body: 'You have a registration checkout to finish.',
    },
    {
      title: 'Finalizar inscripción',
      body: 'Tienes una inscripción pendiente de completar.',
    },
  ),
  'invoice.issued': template(
    'operational',
    { title: 'New invoice', body: 'A new invoice is ready to review.' },
    { title: 'Nueva factura', body: 'Hay una factura nueva para revisar.' },
  ),
  'payment.succeeded': template(
    'operational',
    { title: 'Payment received', body: 'Your payment was received.' },
    { title: 'Pago recibido', body: 'Recibimos tu pago.' },
  ),
  'payment.failed': template(
    'operational',
    {
      title: 'Payment needs attention',
      body: 'Your payment did not complete. Sign in to review it.',
    },
    {
      title: 'Revisa tu pago',
      body: 'El pago no se completó. Inicia sesión para revisarlo.',
    },
  ),
  'installment.upcoming': template(
    'operational',
    {
      title: 'Upcoming installment',
      body: 'An installment payment is coming due.',
    },
    {
      title: 'Próxima cuota',
      body: 'Se acerca la fecha de pago de una cuota.',
    },
  ),
  'installment.failed': template(
    'operational',
    {
      title: 'Installment payment failed',
      body: 'An installment payment needs attention.',
    },
    {
      title: 'Falló el pago de una cuota',
      body: 'Una cuota necesita tu atención.',
    },
  ),
  'installment.final_notice': template(
    'operational',
    {
      title: 'Final payment notice',
      body: 'A final notice is available for an installment.',
    },
    {
      title: 'Aviso final de pago',
      body: 'Hay un aviso final disponible para una cuota.',
    },
  ),
  'refund.issued': template(
    'operational',
    { title: 'Refund issued', body: 'A refund has been issued.' },
    { title: 'Reembolso emitido', body: 'Se emitió un reembolso.' },
  ),
  'autopay.card_expiring': template(
    'operational',
    {
      title: 'Payment method expiring',
      body: 'Update your payment method to avoid a missed payment.',
    },
    {
      title: 'Método de pago por vencer',
      body: 'Actualiza tu método de pago para evitar un pago pendiente.',
    },
  ),
  'credential.expiring': template(
    'operational',
    {
      title: 'Credential expiring',
      body: 'One of your credentials is nearing its expiration date.',
    },
    {
      title: 'Credencial por vencer',
      body: 'Una de tus credenciales está por vencer.',
    },
  ),
  'credential.expired': template(
    'operational',
    {
      title: 'Credential expired',
      body: 'One of your credentials has expired.',
    },
    { title: 'Credencial vencida', body: 'Una de tus credenciales venció.' },
  ),
  'credential.approved': template(
    'operational',
    {
      title: 'Credential approved',
      body: 'Your submitted credential was approved.',
    },
    {
      title: 'Credencial aprobada',
      body: 'Se aprobó la credencial que enviaste.',
    },
  ),
  'credential.rejected': template(
    'operational',
    {
      title: 'Credential needs an update',
      body: 'A submitted credential needs an update.',
    },
    {
      title: 'Actualiza tu credencial',
      body: 'Una credencial enviada necesita una actualización.',
    },
  ),
  'background_check.invitation': template(
    'operational',
    {
      title: 'Background check invitation',
      body: 'A background check invitation is ready.',
    },
    {
      title: 'Invitación para verificación',
      body: 'Hay una invitación para una verificación.',
    },
  ),
  'background_check.result_pending': template(
    'operational',
    {
      title: 'Background check update',
      body: 'There is an update to your background check.',
    },
    {
      title: 'Actualización de verificación',
      body: 'Hay una actualización de tu verificación.',
    },
  ),
  'staff.activated': template(
    'operational',
    { title: 'Staff access active', body: 'Your staff access is active.' },
    {
      title: 'Acceso de personal activo',
      body: 'Tu acceso de personal está activo.',
    },
  ),
  'staff.pending_compliance': template(
    'operational',
    {
      title: 'Complete staff requirements',
      body: 'Your staff access is waiting for a requirement.',
    },
    {
      title: 'Completa los requisitos de personal',
      body: 'Tu acceso de personal espera un requisito.',
    },
  ),
  'team.placement_published': template(
    'operational',
    { title: 'Team placement', body: 'Team placements are ready to review.' },
    {
      title: 'Asignación de equipo',
      body: 'Las asignaciones de equipo están listas para revisar.',
    },
  ),
  'offer.sent': template(
    'operational',
    { title: 'Team offer', body: 'A team offer is ready to review.' },
    {
      title: 'Oferta de equipo',
      body: 'Hay una oferta de equipo para revisar.',
    },
  ),
  'offer.expiring': template(
    'operational',
    {
      title: 'Team offer reminder',
      body: 'A team offer is nearing its response deadline.',
    },
    {
      title: 'Recordatorio de oferta',
      body: 'Se acerca la fecha límite para responder a una oferta.',
    },
  ),
  'schedule.published': template(
    'operational',
    { title: 'Schedule published', body: 'The schedule is ready to view.' },
    {
      title: 'Calendario publicado',
      body: 'El calendario está listo para consultar.',
    },
  ),
  'schedule.changed': template(
    'operational',
    { title: 'Schedule update', body: 'There are schedule changes to review.' },
    {
      title: 'Cambio de calendario',
      body: 'Hay cambios de calendario para revisar.',
    },
  ),
  'event.canceled': template(
    'operational',
    { title: 'Event canceled', body: 'An event was canceled.' },
    { title: 'Evento cancelado', body: 'Se canceló un evento.' },
  ),
  'event.postponed': template(
    'operational',
    { title: 'Event postponed', body: 'An event was postponed.' },
    { title: 'Evento pospuesto', body: 'Se pospuso un evento.' },
  ),
  'event.closure': template(
    'operational',
    { title: 'Facility closure', body: 'A facility closure affects an event.' },
    {
      title: 'Cierre de instalación',
      body: 'El cierre de una instalación afecta un evento.',
    },
  ),
  'rsvp.reminder': template(
    'operational',
    { title: 'RSVP reminder', body: 'Please respond about an upcoming event.' },
    {
      title: 'Recordatorio de asistencia',
      body: 'Confirma tu asistencia a un próximo evento.',
    },
  ),
  'result.posted': template(
    'announcement',
    { title: 'Result posted', body: 'A result is ready to view.' },
    {
      title: 'Resultado publicado',
      body: 'Hay un resultado disponible para consultar.',
    },
    { optIn: true },
  ),
  'official_assignment.offered': template(
    'operational',
    {
      title: 'Official assignment',
      body: 'A game assignment is ready to review.',
    },
    {
      title: 'Asignación de oficial',
      body: 'Hay una asignación de juego para revisar.',
    },
  ),
  'official_assignment.changed': template(
    'operational',
    {
      title: 'Assignment update',
      body: 'There is an update to an official assignment.',
    },
    {
      title: 'Actualización de asignación',
      body: 'Hay una actualización en una asignación de oficial.',
    },
  ),
  'volunteer_shift.reminder': template(
    'operational',
    {
      title: 'Volunteer shift reminder',
      body: 'You have an upcoming volunteer shift.',
    },
    {
      title: 'Recordatorio de turno voluntario',
      body: 'Tienes un próximo turno de voluntariado.',
    },
  ),
  'volunteer_requirement.behind': template(
    'operational',
    {
      title: 'Volunteer requirement update',
      body: 'Your household has a volunteer requirement to review.',
    },
    {
      title: 'Requisito de voluntariado',
      body: 'Tu hogar tiene un requisito de voluntariado para revisar.',
    },
  ),
  'injury.reported': template(
    'operational',
    {
      title: 'Athlete safety update',
      body: 'There is an update for a guardian to review.',
    },
    {
      title: 'Actualización de seguridad del atleta',
      body: 'Hay una actualización para que la revise un tutor.',
    },
  ),
  'communications.chat_message': template(
    'operational',
    {
      title: 'New team message',
      body: 'There is a new message in a conversation you follow.',
    },
    {
      title: 'Nuevo mensaje del equipo',
      body: 'Hay un mensaje nuevo en una conversación que sigues.',
    },
  ),
  'incident.assigned': template(
    'operational',
    {
      title: 'Incident assigned',
      body: 'A restricted incident record needs review.',
    },
    {
      title: 'Incidente asignado',
      body: 'Hay un registro restringido de incidente para revisar.',
    },
    { defaultChannels: ['in_app', 'email'] },
  ),
  'export.ready': template(
    'operational',
    { title: 'Export ready', body: 'Your requested data export is ready.' },
    {
      title: 'Exportación lista',
      body: 'La exportación de datos solicitada está lista.',
    },
  ),
  'privacy_request.updated': template(
    'operational',
    {
      title: 'Privacy request update',
      body: 'There is an update to your privacy request.',
    },
    {
      title: 'Actualización de solicitud de privacidad',
      body: 'Hay una actualización de tu solicitud de privacidad.',
    },
  ),
  'organization.invitation': template(
    'operational',
    {
      title: 'Organization invitation',
      body: 'You have an invitation to join an organization.',
    },
    {
      title: 'Invitación de organización',
      body: 'Tienes una invitación para unirte a una organización.',
    },
  ),
  'communications.campaign': template(
    'announcement',
    {
      title: 'Organization message',
      body: 'You have a new message from your organization.',
    },
    {
      title: 'Mensaje de la organización',
      body: 'Tienes un mensaje nuevo de tu organización.',
    },
  ),
  'communications.emergency': template(
    'emergency',
    {
      title: 'Emergency update',
      body: 'Your organization sent an emergency update.',
    },
    {
      title: 'Aviso de emergencia',
      body: 'Tu organización envió un aviso de emergencia.',
    },
    { defaultChannels: ['in_app', 'email', 'sms', 'push'] },
  ),
} as const;

export type DeliveryChannel = z.infer<typeof deliveryChannelSchema>;
export type CampaignDraft = z.infer<typeof campaignDraftSchema>;
export type CommunicationCategory = z.infer<typeof communicationCategorySchema>;
