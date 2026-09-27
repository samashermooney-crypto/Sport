import { Temporal } from '@js-temporal/polyfill';

import { ageOnDate } from '../dates.js';

export type AgeGroupConfig =
  | {
      method: 'age_on_date';
      monthDay: string;
      yearBasis: 'season_start' | 'season_end' | 'calendar_year_of_start';
    }
  | {
      method: 'birth_year';
      label: 'U{n}' | '{n}U' | '{year}';
      seasonYearBasis: 'season_start' | 'season_end';
    }
  | { method: 'school_grade'; schoolYearCutoff: string }
  | { method: 'none' };

export type AgeGroupInput = {
  dateOfBirth?: string | null;
  graduationYear?: number | null;
  seasonStartsOn: string;
  seasonEndsOn: string;
};

export type AgeGroupResult = {
  age: number | null;
  grade: number | null;
  label: string | null;
  determinationDate: string | null;
};

function monthDayParts(value: string): { month: number; day: number } {
  if (!/^\d{2}-\d{2}$/.test(value)) throw new RangeError('Expected MM-DD');
  const month = Number(value.slice(0, 2));
  const day = Number(value.slice(3));
  Temporal.PlainDate.from({ year: 2000, month, day }, { overflow: 'reject' });
  return { month, day };
}

function dateInYear(year: number, monthDay: string): Temporal.PlainDate {
  const { month, day } = monthDayParts(monthDay);
  // A February 29 determination date follows the same March 1 convention as birthdays.
  if (
    month === 2 &&
    day === 29 &&
    !Temporal.PlainDate.from({ year, month: 1, day: 1 }).inLeapYear
  ) {
    return Temporal.PlainDate.from({ year, month: 3, day: 1 });
  }
  return Temporal.PlainDate.from({ year, month, day }, { overflow: 'reject' });
}

export function schoolYearEndYear(
  programStartsOn: string,
  cutoff: string,
): number {
  const start = Temporal.PlainDate.from(programStartsOn);
  const { month, day } = monthDayParts(cutoff);
  return (
    start.year +
    (start.month > month || (start.month === month && start.day >= day) ? 1 : 0)
  );
}

export function gradeFromGraduationYear(
  graduationYear: number,
  schoolYearEnd: number,
): number {
  if (!Number.isInteger(graduationYear) || !Number.isInteger(schoolYearEnd)) {
    throw new RangeError('Graduation and school years must be integers');
  }
  return 12 - (graduationYear - schoolYearEnd);
}

export function gradeLabel(grade: number): string {
  if (!Number.isInteger(grade))
    throw new RangeError('Grade must be an integer');
  if (grade === -1) return 'Pre-K';
  if (grade === 0) return 'K';
  if (grade < -1 || grade > 12) return `Class of grade ${String(grade)}`;
  const suffix =
    grade % 10 === 1 && grade !== 11
      ? 'st'
      : grade % 10 === 2 && grade !== 12
        ? 'nd'
        : grade % 10 === 3 && grade !== 13
          ? 'rd'
          : 'th';
  return `${String(grade)}${suffix}`;
}

export function calculateAgeGroup(
  config: AgeGroupConfig,
  input: AgeGroupInput,
): AgeGroupResult {
  const start = Temporal.PlainDate.from(input.seasonStartsOn);
  const end = Temporal.PlainDate.from(input.seasonEndsOn);
  if (Temporal.PlainDate.compare(start, end) > 0)
    throw new RangeError('Season end precedes start');
  if (config.method === 'none')
    return { age: null, grade: null, label: null, determinationDate: null };
  if (config.method === 'school_grade') {
    const schoolEnd = schoolYearEndYear(
      input.seasonStartsOn,
      config.schoolYearCutoff,
    );
    const grade =
      input.graduationYear == null
        ? null
        : gradeFromGraduationYear(input.graduationYear, schoolEnd);
    return {
      age: null,
      grade,
      label: grade === null ? null : gradeLabel(grade),
      determinationDate: null,
    };
  }
  if (!input.dateOfBirth)
    return { age: null, grade: null, label: null, determinationDate: null };
  const birth = Temporal.PlainDate.from(input.dateOfBirth);
  if (config.method === 'birth_year') {
    const year =
      config.seasonYearBasis === 'season_end' ? end.year : start.year;
    const n = year - birth.year;
    if (n < 0) throw new RangeError('Date of birth is after season year');
    const label =
      config.label === '{year}'
        ? String(birth.year)
        : config.label === '{n}U'
          ? `${String(n)}U`
          : `U${String(n)}`;
    return { age: n, grade: null, label, determinationDate: null };
  }
  const year = config.yearBasis === 'season_end' ? end.year : start.year;
  const determinationDate = dateInYear(year, config.monthDay).toString();
  const age = ageOnDate(input.dateOfBirth, determinationDate);
  return { age, grade: null, label: String(age), determinationDate };
}
