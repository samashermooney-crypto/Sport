import { z } from 'zod';

/** Destination to offer after a tokenized unsubscribe has been applied. */
export function preferencesCenterPath(orgId: string): string {
  return `/portal/orgs/${z.uuid().parse(orgId)}/notifications#preferences`;
}
