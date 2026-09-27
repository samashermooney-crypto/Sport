import { describe, expect, it } from 'vitest';

import {
  entityIdSchema,
  moneyCentsSchema,
  signedMoneyCentsSchema,
  tenantEntitySchema,
} from './base';
import {
  invoiceEntitySchema,
  invoiceLineEntitySchema,
  paymentEntitySchema,
  refundEntitySchema,
} from './finance';
import {
  attendanceEntitySchema,
  contestEntitySchema,
  credentialEntitySchema,
  eventEntitySchema,
  officialAssignmentEntitySchema,
  registrationEntitySchema,
} from './operations';
import {
  householdEntitySchema,
  householdMemberEntitySchema,
  personEntitySchema,
} from './people';
import {
  divisionEntitySchema,
  offeringEntitySchema,
  programEntitySchema,
  teamSeasonEntitySchema,
} from './programs';

const id = '018fffaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const base = {
  id,
  orgId: id,
  createdAt: '2026-09-26T00:00:00Z',
  updatedAt: '2026-09-26T00:00:00Z',
};

describe('shared spine entity schemas', () => {
  it('rejects unsafe cents, invalid tenant IDs, and unknown fields', () => {
    expect(moneyCentsSchema.safeParse(-1).success).toBe(false);
    expect(
      moneyCentsSchema.safeParse(Number.MAX_SAFE_INTEGER + 1).success,
    ).toBe(false);
    expect(signedMoneyCentsSchema.safeParse(-25).success).toBe(true);
    expect(entityIdSchema.safeParse('wrong').success).toBe(false);
    expect(tenantEntitySchema.safeParse({ ...base, extra: true }).success).toBe(
      false,
    );
  });

  it('provides a typed contract for each core spine family', () => {
    for (const schema of [
      personEntitySchema,
      householdEntitySchema,
      householdMemberEntitySchema,
      programEntitySchema,
      divisionEntitySchema,
      offeringEntitySchema,
      teamSeasonEntitySchema,
      registrationEntitySchema,
      eventEntitySchema,
      contestEntitySchema,
      credentialEntitySchema,
      officialAssignmentEntitySchema,
      attendanceEntitySchema,
      invoiceEntitySchema,
      invoiceLineEntitySchema,
      paymentEntitySchema,
      refundEntitySchema,
    ]) {
      expect(schema.safeParse(base).success).toBe(false);
      expect(schema.shape.orgId.safeParse(id).success).toBe(true);
    }
  });

  it('matches financial status and amount constraints', () => {
    const payment = {
      ...base,
      method: 'card',
      status: 'succeeded',
      amountCents: 100,
      applicationFeeCents: 0,
      processingFeeCents: 0,
      netCents: 100,
      version: 1,
    };
    expect(paymentEntitySchema.safeParse(payment).success).toBe(true);
    expect(
      paymentEntitySchema.safeParse({ ...payment, amountCents: 0 }).success,
    ).toBe(false);
    expect(
      paymentEntitySchema.safeParse({ ...payment, status: 'refunded' }).success,
    ).toBe(false);
  });
});
