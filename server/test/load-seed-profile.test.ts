import { describe, expect, it } from 'vitest';

import { loadRegistrationCountForProgram } from '../../db/seeds/demo';

describe('load seed registration allocation', () => {
  it('keeps exactly 400,000 rows while qualifying the 20,000-person primary org', () => {
    const rowsByOrg = Array.from({ length: 100 }, (_, orgIndex) =>
      Array.from({ length: 4 }, (_, programIndex) =>
        loadRegistrationCountForProgram(orgIndex, programIndex),
      ),
    );

    expect(rowsByOrg[0]).toEqual([5000, 5000, 5000, 5000]);
    expect(rowsByOrg[0]?.reduce((total, count) => total + count, 0)).toBe(
      20_000,
    );
    expect(rowsByOrg.flat().reduce((total, count) => total + count, 0)).toBe(
      400_000,
    );
    const secondaryOrgCounts = rowsByOrg.slice(1).flat();
    expect(secondaryOrgCounts.filter((count) => count === 960)).toHaveLength(
      236,
    );
    expect(secondaryOrgCounts.filter((count) => count === 959)).toHaveLength(
      160,
    );
  });

  it('rejects an organization or standard-program index outside the profile', () => {
    expect(() => loadRegistrationCountForProgram(-1, 0)).toThrow(RangeError);
    expect(() => loadRegistrationCountForProgram(100, 0)).toThrow(RangeError);
    expect(() => loadRegistrationCountForProgram(0, 4)).toThrow(RangeError);
  });
});
