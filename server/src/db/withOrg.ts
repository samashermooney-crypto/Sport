import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';

import { getDatabase } from './kysely';
import type { DB } from './types';

export interface Actor {
  accountId: string;
}

export interface OrgContext {
  orgId: string;
  actor: Actor;
}

export type OrgTransaction = Transaction<DB>;

export function createWithOrg(database: Kysely<DB>) {
  return async function withOrg<T>(
    context: OrgContext,
    fn: (trx: OrgTransaction) => Promise<T>,
  ): Promise<T> {
    return database.transaction().execute(async (trx) => {
      await sql`select set_config('app.org_id', ${context.orgId}, true)`.execute(
        trx,
      );
      await sql`select set_config('app.actor_id', ${context.actor.accountId}, true)`.execute(
        trx,
      );
      return fn(trx);
    });
  };
}

export async function withOrg<T>(
  context: OrgContext,
  fn: (trx: OrgTransaction) => Promise<T>,
): Promise<T> {
  return createWithOrg(getDatabase())(context, fn);
}
