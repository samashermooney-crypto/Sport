import { describe, expect, it } from 'vitest';

import { generateDivisions } from './division-generator';

describe('division generator', () => {
  it('creates U6 through U14 boys and girls as 18 distinct divisions', () => {
    const rows = generateDivisions({
      method: 'birth_year',
      from: 6,
      to: 14,
      genders: ['boys', 'girls'],
    });
    expect(rows).toHaveLength(18);
    expect(new Set(rows.map((row) => row.name)).size).toBe(18);
    expect(rows[0]).toMatchObject({
      name: 'U6 Boys',
      competitionGender: 'male',
    });
    expect(rows[17]).toMatchObject({
      name: 'U14 Girls',
      competitionGender: 'female',
    });
  });
  it('creates grades 3 through 8 boys and girls as 12 divisions', () => {
    const rows = generateDivisions({
      method: 'school_grade',
      from: 3,
      to: 8,
      genders: ['boys', 'girls'],
    });
    expect(rows).toHaveLength(12);
    expect(rows[0]?.ageLabel).toBe('Grade 3');
  });
});
