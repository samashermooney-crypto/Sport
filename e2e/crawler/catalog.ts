/**
 * Mounted screens the owner can open today. `consoleNav` and `portalNav` are
 * still empty, so the crawler walks these routes plus any link the shell,
 * mobile tabs, or page navigation actually render.
 */
export function ownerRoutes(orgId: string): readonly string[] {
  const safety = `/console/safety/${orgId}`;
  const money = `/portal/orgs/${orgId}/money`;
  return [
    `/console/orgs/${orgId}`,
    `/console/orgs/${orgId}/people`,
    `/console/orgs/${orgId}/households`,
    `/console/orgs/${orgId}/audit`,
    `/console/orgs/${orgId}/messages`,
    `/console/orgs/${orgId}/money/billing`,
    safety,
    `${safety}/review`,
    `${safety}/requirements`,
    `${safety}/injuries`,
    `${safety}/incidents`,
    `${safety}/background-checks`,
    `${safety}/background-check-settings`,
    `${safety}/cards`,
    `/orgs/${orgId}/credentials`,
    `/orgs/${orgId}/profile`,
    `/orgs/${orgId}/staff`,
    `/portal/orgs/${orgId}/notifications`,
    money,
    `${money}/invoices`,
    `${money}/installments`,
    `${money}/credits`,
    `${money}/receipts`,
    `${money}/statements`,
    `${money}/autopay`,
    `/me/orgs/${orgId}/messages`,
    '/me',
    '/me/security',
    '/me/family',
    '/start',
  ];
}

export const anonymousRoutes = [
  '/',
  '/sign-up',
  '/forgot-password',
  '/email-link',
  '/mfa',
] as const;

export const platformRoutes = ['/platform', '/me', '/me/security'] as const;

export function accountRoutes(): readonly string[] {
  return ['/me', '/me/security', '/me/family'];
}
