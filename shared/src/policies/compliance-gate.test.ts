import { describe, expect, it } from 'vitest';

import { checkCompliance, type ComplianceInput } from './compliance-gate.js';

const base: ComplianceInput = {
  requirements: [{ typeId: 'safesport' }],
  credentials: [
    { typeId: 'safesport', status: 'verified', expiresOn: '2026-12-31' },
  ],
  dateOfBirth: '1980-01-01',
  minimumAge: 18,
  onDate: '2026-09-01',
};

describe('compliance gate', () => {
  it('activates only verified unexpired credentials and exposes expiry', () => {
    expect(checkCompliance(base)).toMatchObject({
      eligible: true,
      missing: [],
      expiryDate: '2026-12-31',
    });
    expect(
      checkCompliance({ ...base, onDate: '2027-01-01' }).missing[0]?.code,
    ).toBe('CREDENTIAL_EXPIRED');
    expect(checkCompliance({ ...base, credentials: [] }).missing[0]?.code).toBe(
      'CREDENTIAL_MISSING',
    );
  });

  it('enforces minimum age and explicit grace days', () => {
    expect(
      checkCompliance({ ...base, dateOfBirth: '2010-09-02' }).missing[0]?.code,
    ).toBe('UNDER_MINIMUM_AGE');
    expect(
      checkCompliance({
        ...base,
        requirements: [{ typeId: 'safesport', graceDays: 2 }],
        onDate: '2027-01-02',
      }).eligible,
    ).toBe(true);
  });

  it('allows only owner-approved, reasoned overrides for at most 14 days', () => {
    const missing = { ...base, credentials: [] };
    expect(
      checkCompliance({
        ...missing,
        override: {
          ownerApproved: true,
          reason: 'Emergency staffing',
          grantedOn: '2026-09-01',
          expiresOn: '2026-09-15',
        },
      }),
    ).toMatchObject({
      eligible: true,
      overridden: true,
      expiryDate: '2026-09-15',
    });
    expect(() =>
      checkCompliance({
        ...missing,
        override: {
          ownerApproved: true,
          reason: 'x',
          grantedOn: '2026-09-01',
          expiresOn: '2026-09-16',
        },
      }),
    ).toThrow();
    expect(() =>
      checkCompliance({
        ...missing,
        override: {
          ownerApproved: false,
          reason: 'x',
          grantedOn: '2026-09-01',
          expiresOn: '2026-09-15',
        },
      }),
    ).toThrow();
    expect(
      checkCompliance({
        ...missing,
        dateOfBirth: '2010-01-01',
        override: {
          ownerApproved: true,
          reason: 'x',
          grantedOn: '2026-09-01',
          expiresOn: '2026-09-15',
        },
      }).eligible,
    ).toBe(false);
  });

  it('uses the longest valid renewal for each requirement and the earliest requirement expiry', () => {
    const result = checkCompliance({
      ...base,
      requirements: [{ typeId: 'safesport' }, { typeId: 'concussion' }],
      credentials: [
        ...base.credentials,
        { typeId: 'safesport', status: 'verified', expiresOn: '2027-12-31' },
        { typeId: 'concussion', status: 'verified', expiresOn: '2027-01-31' },
      ],
    });
    expect(result.expiryDate).toBe('2027-01-31');
    expect(
      checkCompliance({
        ...base,
        credentials: [
          { typeId: 'safesport', status: 'pending_review', expiresOn: null },
        ],
      }).missing[0]?.code,
    ).toBe('CREDENTIAL_UNVERIFIED');
  });

  it('rejects invalid minimum ages and grace periods', () => {
    expect(() => checkCompliance({ ...base, minimumAge: -1 })).toThrow();
    expect(() =>
      checkCompliance({
        ...base,
        requirements: [{ typeId: 'safesport', graceDays: -1 }],
      }),
    ).toThrow();
  });
});
