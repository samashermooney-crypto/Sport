import { Temporal } from '@js-temporal/polyfill';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { checkCompliance } from './compliance-gate.js';
import {
  earliestAdverseActionDate,
  canAdjudicateIneligible,
} from './fcra-timeline.js';
import { quietHoursDecision } from './quiet-hours.js';
import { proposeRefund } from './refund-policy.js';
import { checkSafeSport } from './safesport.js';

describe('policy properties', () => {
  it('verified credentials cannot reduce compliance eligibility', () => {
    fc.assert(
      fc.property(fc.boolean(), (includeExtra) => {
        const base = {
          requirements: [{ typeId: 'background' }],
          credentials: [
            {
              typeId: 'background',
              status: 'verified' as const,
              expiresOn: null,
            },
          ],
          dateOfBirth: '1990-01-01',
          minimumAge: 18,
          onDate: '2026-09-01',
        };
        const credentials = includeExtra
          ? [
              ...base.credentials,
              {
                typeId: 'background',
                status: 'rejected' as const,
                expiresOn: null,
              },
            ]
          : base.credentials;
        expect(checkCompliance({ ...base, credentials }).eligible).toBe(true);
      }),
    );
  });

  it('never approves a staff-minor direct conversation without a guardian', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 17 }), (age) => {
        const result = checkSafeSport({
          kind: 'direct',
          senderAccountId: 'coach',
          members: [
            { accountId: 'coach', age: 30, adultRole: 'coach', guardianOf: [] },
            { accountId: 'child', age, adultRole: null, guardianOf: [] },
          ],
          guardianLinks: { child: ['guardian'] },
        });
        expect(result.allowed).toBe(false);
        expect(result.code).toBe('SAFESPORT_GUARDIAN_REQUIRED');
      }),
    );
  });

  it('never proposes a refund above amounts still paid', () => {
    fc.assert(
      fc.property(
        fc.nat(100_000),
        fc.nat(10_000),
        fc.integer({ min: 0, max: 10_000 }),
        (paidCents, feeCents, bps) => {
          const refund = proposeRefund(
            [{ id: 'tuition', paidCents }],
            feeCents,
            '2026-09-01',
            { rules: [], afterLastBps: bps, serviceFeeRefund: 'proportional' },
          );
          expect(refund.totalCents).toBeGreaterThanOrEqual(0);
          expect(refund.totalCents).toBeLessThanOrEqual(paidCents + feeCents);
        },
      ),
    );
  });

  it('emergency messages bypass quiet hours in every hour', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 23 }), (hour) => {
        const instant = `2026-09-01T${String(hour).padStart(2, '0')}:00:00Z`;
        expect(
          quietHoursDecision(instant, 'America/Chicago', 'sms', true),
        ).toEqual({ sendNow: true, nextSendAt: null });
      }),
    );
  });

  it('never starts adverse action before five business days have elapsed', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 28 }), (day) => {
        const notice = `2026-09-${String(day).padStart(2, '0')}`;
        const earliest = earliestAdverseActionDate(notice);
        expect(
          Temporal.PlainDate.compare(
            Temporal.PlainDate.from(earliest),
            Temporal.PlainDate.from(notice),
          ),
        ).toBeGreaterThan(0);
        expect(canAdjudicateIneligible(notice, earliest)).toBe(true);
        expect(
          canAdjudicateIneligible(
            notice,
            Temporal.PlainDate.from(earliest).subtract({ days: 1 }).toString(),
          ),
        ).toBe(false);
      }),
    );
  });
});
