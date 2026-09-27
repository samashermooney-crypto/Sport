export const notificationCatalog = {
  'account.security': { category: 'operational', title: 'Account security' },
  'registration.confirmed': {
    category: 'operational',
    title: 'Registration confirmed',
  },
  'registration.waitlist_offer': {
    category: 'operational',
    title: 'Waitlist offer',
  },
  'finance.payment_due': { category: 'operational', title: 'Payment due' },
  'finance.payment_failed': {
    category: 'operational',
    title: 'Payment failed',
  },
  'schedule.changed': { category: 'operational', title: 'Schedule changed' },
  'compliance.expiring': {
    category: 'operational',
    title: 'Credential expiring',
  },
  'compliance.credential_expiry_reminder': {
    category: 'operational',
    title: 'Credential expiring',
  },
  'compliance.credential_expired': {
    category: 'operational',
    title: 'Credential expired',
  },
  'compliance.credential_rejected': {
    category: 'operational',
    title: 'Credential needs review',
  },
  'compliance.credential_revoked': {
    category: 'operational',
    title: 'Credential revoked',
  },
  'compliance.credential_verified': {
    category: 'operational',
    title: 'Credential verified',
  },
  'compliance.role_activated': {
    category: 'operational',
    title: 'Staff access active',
  },
  'compliance.role_demoted': {
    category: 'operational',
    title: 'Staff requirements need review',
  },
  'compliance.background_check_adverse_notice': {
    category: 'operational',
    title: 'Background check notice',
  },
  'compliance.background_check_dispute_submitted': {
    category: 'operational',
    title: 'Background check dispute submitted',
  },
  'compliance.background_check_adjudicated': {
    category: 'operational',
    title: 'Background check adjudicated',
  },
  'compliance.background_check_result': {
    category: 'operational',
    title: 'Background check update',
  },
  'registration.waitlisted': {
    category: 'operational',
    title: 'Waitlist update',
  },
  'registration.offered': {
    category: 'operational',
    title: 'Registration offer',
  },
  'registration.approved': {
    category: 'operational',
    title: 'Registration approved',
  },
  'registration.declined': {
    category: 'operational',
    title: 'Registration update',
  },
  'registration.canceled': {
    category: 'operational',
    title: 'Registration canceled',
  },
  'registration.transferred': {
    category: 'operational',
    title: 'Registration transferred',
  },
  'checkout.abandoned': {
    category: 'operational',
    title: 'Registration checkout',
  },
  'invoice.issued': { category: 'operational', title: 'New invoice' },
  'payment.succeeded': { category: 'operational', title: 'Payment received' },
  'payment.failed': {
    category: 'operational',
    title: 'Payment needs attention',
  },
  'installment.upcoming': {
    category: 'operational',
    title: 'Upcoming installment',
  },
  'installment.failed': {
    category: 'operational',
    title: 'Installment payment failed',
  },
  'installment.final_notice': {
    category: 'operational',
    title: 'Final payment notice',
  },
  'refund.issued': { category: 'operational', title: 'Refund issued' },
  'autopay.card_expiring': {
    category: 'operational',
    title: 'Payment method expiring',
  },
  'credential.expiring': {
    category: 'operational',
    title: 'Credential expiring',
  },
  'credential.expired': {
    category: 'operational',
    title: 'Credential expired',
  },
  'credential.approved': {
    category: 'operational',
    title: 'Credential approved',
  },
  'credential.rejected': {
    category: 'operational',
    title: 'Credential needs an update',
  },
  'background_check.invitation': {
    category: 'operational',
    title: 'Background check invitation',
  },
  'background_check.result_pending': {
    category: 'operational',
    title: 'Background check update',
  },
  'staff.activated': { category: 'operational', title: 'Staff access active' },
  'staff.pending_compliance': {
    category: 'operational',
    title: 'Complete staff requirements',
  },
  'team.placement_published': {
    category: 'operational',
    title: 'Team placement',
  },
  'offer.sent': { category: 'operational', title: 'Team offer' },
  'offer.expiring': { category: 'operational', title: 'Team offer reminder' },
  'schedule.published': {
    category: 'operational',
    title: 'Schedule published',
  },
  'event.canceled': { category: 'operational', title: 'Event canceled' },
  'event.postponed': { category: 'operational', title: 'Event postponed' },
  'event.closure': { category: 'operational', title: 'Facility closure' },
  'rsvp.reminder': { category: 'operational', title: 'RSVP reminder' },
  'result.posted': { category: 'announcement', title: 'Result posted' },
  'official_assignment.offered': {
    category: 'operational',
    title: 'Official assignment',
  },
  'official_assignment.changed': {
    category: 'operational',
    title: 'Assignment update',
  },
  'volunteer_shift.reminder': {
    category: 'operational',
    title: 'Volunteer shift reminder',
  },
  'volunteer_requirement.behind': {
    category: 'operational',
    title: 'Volunteer requirement update',
  },
  'injury.reported': {
    category: 'operational',
    title: 'Athlete safety update',
  },
  'communications.chat_message': {
    category: 'operational',
    title: 'New team message',
  },
  'incident.assigned': { category: 'operational', title: 'Incident assigned' },
  'export.ready': { category: 'operational', title: 'Export ready' },
  'privacy_request.updated': {
    category: 'operational',
    title: 'Privacy request update',
  },
  'organization.invitation': {
    category: 'operational',
    title: 'Organization invitation',
  },
  'communications.campaign': {
    category: 'announcement',
    title: 'Organization message',
  },
  'communications.emergency': {
    category: 'emergency',
    title: 'Emergency update',
  },
  'organization.announcement': {
    category: 'announcement',
    title: 'Organization announcement',
  },
  'organization.marketing': {
    category: 'marketing',
    title: 'Organization news',
  },
  'evaluation.offer': { category: 'operational', title: 'Team offer' },
  'safety.emergency': { category: 'emergency', title: 'Emergency alert' },
} as const;

export type NotificationType = keyof typeof notificationCatalog;
export type NotificationCategory =
  (typeof notificationCatalog)[NotificationType]['category'];
export const notificationTypes = Object.keys(
  notificationCatalog,
) as NotificationType[];

export function isNotificationType(value: string): value is NotificationType {
  return Object.prototype.hasOwnProperty.call(notificationCatalog, value);
}
