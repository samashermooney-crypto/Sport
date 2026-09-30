import { requireAnyRole } from '../compliance/access';

/** Roles allowed to administer federation surfaces on either side. */
export const FEDERATION_ADMIN_ROLES = ['owner', 'admin', 'director'] as const;
/** Club-side staff allowed to submit entries and offer field windows. */
export const FEDERATION_SUBMIT_ROLES = [
  'owner',
  'admin',
  'director',
  'registrar',
] as const;
/** League-side roles that may run schedule generation/apply. */
export const FEDERATION_SCHEDULE_ROLES = [
  'owner',
  'admin',
  'director',
  'scheduler',
] as const;
/** League-side roles that may issue/manage federation discipline. */
export const FEDERATION_DISCIPLINE_ROLES = [
  'owner',
  'admin',
  'director',
  'compliance',
] as const;
/** League-side roles that may assess/invoice federation fees. */
export const FEDERATION_FINANCE_ROLES = [
  'owner',
  'admin',
  'director',
  'finance',
] as const;
/** League-side roles that may read allow-listed member data. */
export const FEDERATION_READ_ROLES = [
  'owner',
  'admin',
  'director',
  'compliance',
  'scheduler',
  'finance',
  'reporter',
] as const;
/** Roles that need relationship names to reach a league entry workflow. */
export const FEDERATION_RELATIONSHIP_ROLES = [
  ...new Set([...FEDERATION_READ_ROLES, ...FEDERATION_SUBMIT_ROLES]),
] as const;
/** League-side roles that may manage the referee pool. */
export const FEDERATION_REFEREE_ROLES = [
  'owner',
  'admin',
  'director',
  'scheduler',
] as const;

export function requireFederationRole(
  roles: readonly string[],
  allowed: readonly string[],
): void {
  requireAnyRole(roles, allowed);
}

export function federationCapabilities(roles: readonly string[]) {
  return {
    relationships: FEDERATION_RELATIONSHIP_ROLES.some((role) =>
      roles.includes(role),
    ),
    manageRelationships: FEDERATION_ADMIN_ROLES.some((role) =>
      roles.includes(role),
    ),
    directory: FEDERATION_READ_ROLES.some((role) => roles.includes(role)),
    submitEntries: FEDERATION_SUBMIT_ROLES.some((role) => roles.includes(role)),
    schedule: FEDERATION_SCHEDULE_ROLES.some((role) => roles.includes(role)),
    discipline: FEDERATION_DISCIPLINE_ROLES.some((role) =>
      roles.includes(role),
    ),
    referees: FEDERATION_REFEREE_ROLES.some((role) => roles.includes(role)),
    finance: FEDERATION_FINANCE_ROLES.some((role) => roles.includes(role)),
  };
}
