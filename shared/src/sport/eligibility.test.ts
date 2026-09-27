import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  checkEligibility,
  type EligibilityFacts,
  type EligibilityRules,
} from './eligibility.js';

const rules: EligibilityRules = {
  ageGroup: {
    method: 'birth_year',
    label: 'U{n}',
    seasonYearBasis: 'season_end',
  },
  minAge: 10,
  maxAge: 12,
  competitionGender: 'female',
  requiredMembershipProgramIds: ['member-2026'],
  returningOnly: true,
  inviteOnly: true,
  residencyRequired: true,
  maxRegistrationsPerHousehold: 3,
};
const facts: EligibilityFacts = {
  seasonStartsOn: '2026-08-01',
  seasonEndsOn: '2027-06-01',
  dateOfBirth: '2015-04-01',
  competitionGender: 'female',
  activeMembershipProgramIds: ['member-2026'],
  returningParticipant: true,
  invited: true,
  residencyVerified: true,
  householdRegistrations: 2,
};

describe('eligibility', () => {
  it('accepts a fully eligible participant', () => {
    expect(checkEligibility(rules, facts)).toMatchObject({
      eligible: true,
      reasons: [],
      age: 12,
      ageGroupLabel: 'U12',
      overridden: false,
    });
  });

  it('reports all reasons with family-readable messages', () => {
    const result = checkEligibility(rules, {
      ...facts,
      dateOfBirth: '2019-01-01',
      competitionGender: 'male',
      activeMembershipProgramIds: [],
      returningParticipant: false,
      invited: false,
      residencyVerified: false,
      householdRegistrations: 3,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons.map((reason) => reason.code)).toEqual([
      'AGE_BELOW_MIN',
      'GENDER_MISMATCH',
      'MEMBERSHIP_REQUIRED',
      'RETURNING_ONLY',
      'INVITE_ONLY',
      'RESIDENCY',
      'HOUSEHOLD_LIMIT',
    ]);
    expect(result.reasons.every((reason) => reason.message.length > 10)).toBe(
      true,
    );
  });

  it('requires a nonempty recorded override reason', () => {
    const ineligible = { ...facts, dateOfBirth: '2019-01-01' };
    expect(checkEligibility(rules, ineligible, '   ').eligible).toBe(false);
    expect(
      checkEligibility(rules, ineligible, 'Play-up approved'),
    ).toMatchObject({
      eligible: true,
      overridden: true,
      overrideReason: 'Play-up approved',
    });
  });

  it('fails closed when age or grade data is missing', () => {
    expect(
      checkEligibility(rules, { ...facts, dateOfBirth: null }).reasons[0]?.code,
    ).toBe('DATE_OF_BIRTH_REQUIRED');
    const gradeRules: EligibilityRules = {
      ageGroup: { method: 'school_grade', schoolYearCutoff: '08-01' },
      minGrade: 2,
      maxGrade: 4,
    };
    expect(checkEligibility(gradeRules, facts).reasons[0]?.code).toBe(
      'GRADUATION_YEAR_REQUIRED',
    );
    expect(
      checkEligibility(gradeRules, { ...facts, graduationYear: 2033 })
        .reasons[0]?.code,
    ).toBe('GRADE_OUT_OF_RANGE');
  });

  it('never rejects a participant inside an inclusive age range', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 30 }),
        (a, b) => {
          const minAge = Math.min(a, b);
          const maxAge = Math.max(a, b);
          const result = checkEligibility(
            { ageGroup: rules.ageGroup, minAge, maxAge },
            { ...facts, dateOfBirth: `${String(2027 - minAge)}-01-01` },
          );
          expect(
            result.reasons.some(
              (reason) =>
                reason.code === 'AGE_BELOW_MIN' ||
                reason.code === 'AGE_ABOVE_MAX',
            ),
          ).toBe(false);
        },
      ),
    );
  });
});
