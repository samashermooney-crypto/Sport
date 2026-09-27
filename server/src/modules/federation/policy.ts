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
