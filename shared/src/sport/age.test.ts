import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  calculateAgeGroup,
  gradeFromGraduationYear,
  gradeLabel,
  schoolYearEndYear,
} from './age.js';

const season = { seasonStartsOn: '2026-08-15', seasonEndsOn: '2027-06-15' };

describe('sport age groups', () => {
  it('uses the season end year for birth-year U groups', () => {
    expect(
      calculateAgeGroup(
        { method: 'birth_year', label: 'U{n}', seasonYearBasis: 'season_end' },
        { ...season, dateOfBirth: '2015-12-30' },
      ),
    ).toMatchObject({ age: 12, label: 'U12' });
    expect(
      calculateAgeGroup(
        {
          method: 'birth_year',
          label: '{n}U',
          seasonYearBasis: 'season_start',
        },
        { ...season, dateOfBirth: '2015-12-30' },
      ),
    ).toMatchObject({ age: 11, label: '11U' });
    expect(
      calculateAgeGroup(
        {
          method: 'birth_year',
          label: '{year}',
          seasonYearBasis: 'season_end',
        },
        { ...season, dateOfBirth: '2015-12-30' },
      ),
    ).toMatchObject({ label: '2015' });
  });

  it('uses the shared leap-day birthday convention', () => {
    const config = {
      method: 'age_on_date' as const,
      monthDay: '02-28',
      yearBasis: 'season_end' as const,
    };
    expect(
      calculateAgeGroup(config, { ...season, dateOfBirth: '2016-02-29' }).age,
    ).toBe(10);
    expect(
      calculateAgeGroup(
        { ...config, monthDay: '03-01' },
        { ...season, dateOfBirth: '2016-02-29' },
      ).age,
    ).toBe(11);
  });

  it('moves February 29 determination dates to March 1 in non-leap years', () => {
    expect(
      calculateAgeGroup(
        { method: 'age_on_date', monthDay: '02-29', yearBasis: 'season_end' },
        { ...season, dateOfBirth: '2016-02-29' },
      ).determinationDate,
    ).toBe('2027-03-01');
  });

  it('derives grades from graduation year and school-year cutoff', () => {
    expect(schoolYearEndYear('2026-08-15', '08-01')).toBe(2027);
    expect(schoolYearEndYear('2027-07-31', '08-01')).toBe(2027);
    expect(
      calculateAgeGroup(
        { method: 'school_grade', schoolYearCutoff: '08-01' },
        { ...season, graduationYear: 2033 },
      ),
    ).toMatchObject({ grade: 6, label: '6th' });
    expect(gradeLabel(0)).toBe('K');
    expect(gradeLabel(-1)).toBe('Pre-K');
    expect(gradeLabel(1)).toBe('1st');
    expect(gradeLabel(2)).toBe('2nd');
    expect(gradeLabel(3)).toBe('3rd');
    expect(gradeLabel(12)).toBe('12th');
  });

  it('is monotonic in graduation year', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2020, max: 2050 }),
        fc.integer({ min: 2020, max: 2050 }),
        (a, b) => {
          if (a < b)
            expect(gradeFromGraduationYear(a, 2027)).toBeGreaterThan(
              gradeFromGraduationYear(b, 2027),
            );
        },
      ),
    );
  });

  it('rejects malformed dates and reversed seasons', () => {
    expect(() =>
      calculateAgeGroup(
        { method: 'age_on_date', monthDay: '13-01', yearBasis: 'season_start' },
        { ...season, dateOfBirth: '2016-01-01' },
      ),
    ).toThrow();
    expect(() =>
      calculateAgeGroup(
        { method: 'none' },
        {
          seasonStartsOn: season.seasonEndsOn,
          seasonEndsOn: season.seasonStartsOn,
        },
      ),
    ).toThrow();
  });

  it('handles absent birth dates, grade labels and invalid year inputs', () => {
    expect(calculateAgeGroup({ method: 'none' }, season).label).toBeNull();
    expect(
      calculateAgeGroup(
        {
          method: 'birth_year',
          label: 'U{n}',
          seasonYearBasis: 'season_start',
        },
        season,
      ).age,
    ).toBeNull();
    expect(gradeLabel(-2)).toContain('-2');
    expect(() => gradeLabel(1.5)).toThrow();
    expect(() => gradeFromGraduationYear(2033.5, 2027)).toThrow();
    expect(() =>
      calculateAgeGroup(
        {
          method: 'birth_year',
          label: 'U{n}',
          seasonYearBasis: 'season_start',
        },
        { ...season, dateOfBirth: '2030-01-01' },
      ),
    ).toThrow();
  });
});
