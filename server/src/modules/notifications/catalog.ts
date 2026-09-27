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
