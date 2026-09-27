import { Temporal } from '@js-temporal/polyfill';

import { ageOnDate } from '../dates.js';

export type CredentialRequirement = { typeId: string; graceDays?: number };
export type CredentialEvidence = {
  typeId: string;
  status: 'pending_review' | 'verified' | 'rejected' | 'expired' | 'revoked';
  expiresOn: string | null;
};
export type ComplianceOverride = {
  ownerApproved: boolean;
  reason: string;
  grantedOn: string;
  expiresOn: string;
};
export type ComplianceInput = {
  requirements: readonly CredentialRequirement[];
  credentials: readonly CredentialEvidence[];
  dateOfBirth: string;
  minimumAge: number;
  onDate: string;
  override?: ComplianceOverride | null;
};
export type ComplianceMissing = {
  code:
    | 'UNDER_MINIMUM_AGE'
    | 'CREDENTIAL_MISSING'
    | 'CREDENTIAL_UNVERIFIED'
    | 'CREDENTIAL_EXPIRED';
  typeId?: string;
  message: string;
};
export type ComplianceResult = {
  eligible: boolean;
  missing: ComplianceMissing[];
  expiryDate: string | null;
  overridden: boolean;
};

export function checkCompliance(input: ComplianceInput): ComplianceResult {
  const date = Temporal.PlainDate.from(input.onDate);
  if (!Number.isSafeInteger(input.minimumAge) || input.minimumAge < 0)
    throw new RangeError('minimumAge must be non-negative');
  const missing: ComplianceMissing[] = [];
  if (ageOnDate(input.dateOfBirth, input.onDate) < input.minimumAge)
    missing.push({
      code: 'UNDER_MINIMUM_AGE',
      message: `Person must be at least ${String(input.minimumAge)} years old.`,
    });
  const expiries: Temporal.PlainDate[] = [];
  for (const requirement of input.requirements) {
    const grace = requirement.graceDays ?? 0;
    if (!Number.isSafeInteger(grace) || grace < 0)
      throw new RangeError('Grace days must be non-negative');
    const candidates = input.credentials.filter(
      (credential) => credential.typeId === requirement.typeId,
    );
    const verified = candidates.filter(
      (credential) => credential.status === 'verified',
    );
    const valid = verified.filter(
      (credential) =>
        credential.expiresOn === null ||
        Temporal.PlainDate.compare(
          Temporal.PlainDate.from(credential.expiresOn).add({ days: grace }),
          date,
        ) >= 0,
    );
    if (valid.length) {
      if (!valid.some((credential) => credential.expiresOn === null)) {
        const furthest = valid
          .map((credential) =>
            Temporal.PlainDate.from(credential.expiresOn ?? '').add({
              days: grace,
            }),
          )
          .sort((a, b) => Temporal.PlainDate.compare(b, a))[0];
        if (furthest) expiries.push(furthest);
      }
    } else if (!candidates.length)
      missing.push({
        code: 'CREDENTIAL_MISSING',
        typeId: requirement.typeId,
        message: 'Required credential has not been submitted.',
      });
    else if (verified.length)
      missing.push({
        code: 'CREDENTIAL_EXPIRED',
        typeId: requirement.typeId,
        message: 'Required credential has expired.',
      });
    else
      missing.push({
        code: 'CREDENTIAL_UNVERIFIED',
        typeId: requirement.typeId,
        message: 'Required credential is not verified.',
      });
  }
  const override = input.override;
  let overridden = false;
  if (override) {
    const granted = Temporal.PlainDate.from(override.grantedOn);
    const expires = Temporal.PlainDate.from(override.expiresOn);
    if (!override.ownerApproved || !override.reason.trim())
      throw new RangeError('Override requires owner approval and a reason');
    if (
      Temporal.PlainDate.compare(expires, granted) < 0 ||
      Temporal.PlainDate.compare(expires, granted.add({ days: 14 })) > 0
    )
      throw new RangeError('Override must expire within 14 days');
    overridden =
      missing.length > 0 &&
      !missing.some((item) => item.code === 'UNDER_MINIMUM_AGE') &&
      Temporal.PlainDate.compare(date, granted) >= 0 &&
      Temporal.PlainDate.compare(date, expires) <= 0;
  }
  const expiry =
    overridden && override
      ? override.expiresOn
      : expiries.length
        ? (expiries
            .sort((a, b) => Temporal.PlainDate.compare(a, b))[0]
            ?.toString() ?? null)
        : null;
  return {
    eligible: missing.length === 0 || overridden,
    missing,
    expiryDate: expiry,
    overridden,
  };
}
