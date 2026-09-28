import { describe, expect, it } from 'vitest';

import {
  isNotificationType,
  notificationCatalog,
  notificationTypes,
} from './catalog';
import { notificationStreamEvent } from './stream';

describe('notification catalog and stream envelope', () => {
  it('defines every type once with a supported category', () => {
    expect(new Set(notificationTypes).size).toBe(notificationTypes.length);
    for (const type of notificationTypes) {
      expect(isNotificationType(type)).toBe(true);
      expect([
        'operational',
        'announcement',
        'marketing',
        'emergency',
      ]).toContain(notificationCatalog[type].category);
    }
    expect(isNotificationType('__proto__')).toBe(false);
  });

  it('registers all Phase 11 module notification types', () => {
    expect(notificationTypes).toEqual(
      expect.arrayContaining([
        'fundraising.donation_receipt',
        'fundraising.campaign_update',
        'sponsor.renewal_reminder',
        'store.order_update',
        'store.low_stock',
        'volunteer.shift_reminder',
        'volunteer.requirement_behind',
        'team.fee_assessed',
        'team.reimbursement_decided',
      ]),
    );
  });

  it('emits only a matching account envelope without payload content', () => {
    const accountId = 'f004ab0e-0c56-4e3d-a412-6c383487208c';
    const payload = JSON.stringify({
      id: 'fe9f2d7d-b9e0-46af-a69d-bf283f567090',
      orgId: '8c5004ea-0828-47c6-9c0c-d33246ce9afe',
      accountId,
      sensitive: 'discard',
    });
    expect(notificationStreamEvent(payload, accountId)).toBeNull();
    const safePayload = JSON.stringify({
      id: 'fe9f2d7d-b9e0-46af-a69d-bf283f567090',
      orgId: '8c5004ea-0828-47c6-9c0c-d33246ce9afe',
      accountId,
    });
    expect(notificationStreamEvent(safePayload, accountId)?.data).toEqual({
      id: 'fe9f2d7d-b9e0-46af-a69d-bf283f567090',
      orgId: '8c5004ea-0828-47c6-9c0c-d33246ce9afe',
    });
    expect(
      notificationStreamEvent(
        safePayload,
        '3208481e-5bad-4e82-b9fb-9c93fa172954',
      ),
    ).toBeNull();
    expect(notificationStreamEvent('{broken', accountId)).toBeNull();
  });
});
