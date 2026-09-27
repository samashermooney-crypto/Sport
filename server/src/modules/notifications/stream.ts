import { z } from 'zod';

import type { SseEvent } from '../../lib/sse';

export const notificationChannel = 'athlentry_notifications';

const envelopeSchema = z.strictObject({
  id: z.uuid(),
  orgId: z.uuid(),
  accountId: z.uuid(),
});

export function notificationStreamEvent(
  payload: string,
  accountId: string,
): SseEvent | null {
  try {
    const parsed = envelopeSchema.safeParse(JSON.parse(payload) as unknown);
    if (!parsed.success || parsed.data.accountId !== accountId) return null;
    return {
      id: parsed.data.id,
      event: 'notification',
      data: { id: parsed.data.id, orgId: parsed.data.orgId },
    };
  } catch {
    return null;
  }
}
