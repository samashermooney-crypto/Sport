import type { Kysely } from 'kysely';

import type { DB } from '../../db/types.js';

import type { RefundApprovalPolicy } from './refunds.js';
import { FinanceAccessError, requireFinanceStaff } from './staff-access.js';

export class PostgresRefundApprovalPolicy implements RefundApprovalPolicy {
  constructor(private readonly database: Kysely<DB>) {}

  async isAuthorizedSecondApprover(
    orgId: string,
    accountId: string,
  ): Promise<boolean> {
    try {
      await requireFinanceStaff(this.database, {
        orgId,
        actor: { accountId },
      });
      return true;
    } catch (error) {
      if (error instanceof FinanceAccessError) return false;
      throw error;
    }
  }
}
