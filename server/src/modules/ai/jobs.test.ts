import type { Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';

import type { DB } from '../../db/types';

import { expireAiConversations } from './jobs';

describe('expireAiConversations', () => {
  it('deletes expired conversations and totals deleted rows', async () => {
    const execute = vi
      .fn()
      .mockResolvedValue([{ numDeletedRows: 2n }, { numDeletedRows: 3n }]);
    const where = vi.fn().mockReturnValue({ execute });
    const deleteFrom = vi.fn().mockReturnValue({ where });
    const database = { deleteFrom } as unknown as Kysely<DB>;

    await expect(expireAiConversations(database)).resolves.toBe(5);
    expect(deleteFrom).toHaveBeenCalledWith('ai_conversations');
    expect(where).toHaveBeenCalledWith('expires_at', '<', expect.any(Date));
  });

  it('returns zero when no conversation expired', async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ execute });
    const database = {
      deleteFrom: vi.fn().mockReturnValue({ where }),
    } as unknown as Kysely<DB>;

    await expect(expireAiConversations(database)).resolves.toBe(0);
  });
});
