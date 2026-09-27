import type { Kysely } from 'kysely';

import type { DB } from '../../db/types';

export async function expireAiConversations(
  database: Kysely<DB>,
): Promise<number> {
  const result = await database
    .deleteFrom('ai_conversations')
    .where('expires_at', '<', new Date())
    .execute();
  return result.reduce((sum, row) => sum + Number(row.numDeletedRows), 0);
}
