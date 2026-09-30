import { describe, expect, it } from 'vitest';

import { databasePoolMax } from './kysely';

describe('databasePoolMax', () => {
  it('defaults to 20 and accepts bounded integers', () => {
    expect(databasePoolMax(undefined)).toBe(20);
    expect(databasePoolMax('')).toBe(20);
    expect(databasePoolMax('35')).toBe(35);
  });

  it('rejects values that would exhaust or disable the pool', () => {
    for (const value of ['0', '201', '2.5', 'many'])
      expect(() => databasePoolMax(value)).toThrow(
        'DATABASE_POOL_MAX must be an integer from 1 to 200',
      );
  });
});
