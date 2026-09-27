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
  'organization.announcement': {
    category: 'announcement',
    title: 'Organization announcement',
  },
  'organization.marketing': {
    category: 'marketing',
    title: 'Organization news',
  },
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
