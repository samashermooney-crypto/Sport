/**
 * Entry points for the navigation surfaces that are implemented on trunk.
 * The crawler discovers destinations from the rendered navigation on each
 * page; these are only seeds used to reach each role's shell.
 */
export const anonymousEntryRoutes = [
  '/',
  '/sign-up',
  '/forgot-password',
  '/email-link',
  '/mfa',
  '/site/qa-crawler/sponsors',
  '/site/qa-crawler/fundraisers/qa-campaign',
] as const;

export const organizationRoles = [
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
] as const;

export const platformRoles = [
  { name: 'platform_super_admin', databaseRole: 'super_admin' },
  { name: 'platform_support', databaseRole: 'support' },
  { name: 'platform_finance_ops', databaseRole: 'finance_ops' },
] as const;

export function organizationEntryRoutes(orgId: string): readonly string[] {
  return [`/console/orgs/${orgId}`, '/me', '/me/security', '/me/family'];
}

export function familyEntryRoutes(orgId: string): readonly string[] {
  return [
    '/me/family',
    '/me',
    '/me/security',
    `/portal/orgs/${orgId}/notifications`,
  ];
}

export const platformEntryRoutes = [
  '/platform',
  '/me',
  '/me/security',
] as const;
