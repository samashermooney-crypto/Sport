import {
  calculateAgeGroup,
  type AgeGroupConfig,
  type AgeGroupInput,
} from './age.js';

export type EligibilityReasonCode =
  | 'AGE_BELOW_MIN'
  | 'AGE_ABOVE_MAX'
  | 'GRADE_OUT_OF_RANGE'
  | 'GENDER_MISMATCH'
  | 'MEMBERSHIP_REQUIRED'
  | 'RETURNING_ONLY'
  | 'INVITE_ONLY'
  | 'RESIDENCY'
  | 'HOUSEHOLD_LIMIT'
  | 'DATE_OF_BIRTH_REQUIRED'
  | 'GRADUATION_YEAR_REQUIRED';

export type EligibilityReason = {
  code: EligibilityReasonCode;
  message: string;
};

export type EligibilityRules = {
  ageGroup: AgeGroupConfig;
  minAge?: number;
  maxAge?: number;
  minGrade?: number;
  maxGrade?: number;
  competitionGender?: 'female' | 'male' | 'open';
  requiredMembershipProgramIds?: readonly string[];
  returningOnly?: boolean;
  inviteOnly?: boolean;
  residencyRequired?: boolean;
  maxRegistrationsPerHousehold?: number;
};

export type EligibilityFacts = AgeGroupInput & {
  competitionGender?: 'female' | 'male' | 'open' | null;
  activeMembershipProgramIds?: readonly string[];
  returningParticipant?: boolean;
  invited?: boolean;
  residencyVerified?: boolean;
  householdRegistrations?: number;
};

export type EligibilityResult = {
  eligible: boolean;
  reasons: EligibilityReason[];
  overridden: boolean;
  overrideReason: string | null;
  age: number | null;
  grade: number | null;
  ageGroupLabel: string | null;
};

export function checkEligibility(
  rules: EligibilityRules,
  facts: EligibilityFacts,
  overrideReason?: string | null,
): EligibilityResult {
  const group = calculateAgeGroup(rules.ageGroup, facts);
  const reasons: EligibilityReason[] = [];
  const add = (code: EligibilityReasonCode, message: string): void => {
    reasons.push({ code, message });
  };
  if (rules.minAge !== undefined || rules.maxAge !== undefined) {
    if (group.age === null)
      add(
        'DATE_OF_BIRTH_REQUIRED',
        'Add the athlete’s date of birth to check age eligibility.',
      );
    else {
      if (rules.minAge !== undefined && group.age < rules.minAge)
        add(
          'AGE_BELOW_MIN',
          `Athlete must be at least ${String(rules.minAge)} years old.`,
        );
      if (rules.maxAge !== undefined && group.age > rules.maxAge)
        add(
          'AGE_ABOVE_MAX',
          `Athlete must be no older than ${String(rules.maxAge)} years.`,
        );
    }
  }
  if (rules.minGrade !== undefined || rules.maxGrade !== undefined) {
    if (group.grade === null)
      add(
        'GRADUATION_YEAR_REQUIRED',
        'Add the athlete’s graduation year to check grade eligibility.',
      );
    else if (
      (rules.minGrade !== undefined && group.grade < rules.minGrade) ||
      (rules.maxGrade !== undefined && group.grade > rules.maxGrade)
    ) {
      add(
        'GRADE_OUT_OF_RANGE',
        'Athlete’s school grade is outside this program’s allowed range.',
      );
    }
  }
  if (
    rules.competitionGender &&
    rules.competitionGender !== 'open' &&
    facts.competitionGender !== rules.competitionGender
  ) {
    add(
      'GENDER_MISMATCH',
      'This division has a competition eligibility category the athlete does not meet.',
    );
  }
  const memberships = new Set(facts.activeMembershipProgramIds ?? []);
  if (rules.requiredMembershipProgramIds?.some((id) => !memberships.has(id))) {
    add(
      'MEMBERSHIP_REQUIRED',
      'An active membership is required for this program.',
    );
  }
  if (rules.returningOnly && !facts.returningParticipant)
    add('RETURNING_ONLY', 'This offering is for returning participants.');
  if (rules.inviteOnly && !facts.invited)
    add('INVITE_ONLY', 'An invitation is required for this offering.');
  if (rules.residencyRequired && !facts.residencyVerified)
    add('RESIDENCY', 'Residency verification is required.');
  if (
    rules.maxRegistrationsPerHousehold !== undefined &&
    (facts.householdRegistrations ?? 0) >= rules.maxRegistrationsPerHousehold
  ) {
    add(
      'HOUSEHOLD_LIMIT',
      'This household has reached the registration limit.',
    );
  }
  const reason = overrideReason?.trim() || null;
  const overridden = reasons.length > 0 && reason !== null;
  return {
    eligible: reasons.length === 0 || overridden,
    reasons,
    overridden,
    overrideReason: overridden ? reason : null,
    age: group.age,
    grade: group.grade,
    ageGroupLabel: group.label,
  };
}
