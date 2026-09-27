import { z } from 'zod';

export const authTokenPurposeSchema = z.enum([
  'verify_email',
  'magic_link',
  'reset_password',
  'org_invitation',
  'guardian_invitation',
  'athlete_account_invitation',
  'claim_person',
  'email_change',
  'mfa_challenge',
]);

export const authTokenPayloadSchema = z.record(z.string(), z.json());

export type AuthTokenPurpose = z.infer<typeof authTokenPurposeSchema>;

export const signUpSchema = z.strictObject({
  email: z.email().max(254),
  password: z.string(),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  dateOfBirth: z.iso.date(),
  termsAccepted: z.literal(true),
  privacyAccepted: z.literal(true),
  captchaToken: z.string().min(1),
});

export type SignUpInput = z.infer<typeof signUpSchema>;

export const tokenBodySchema = z.strictObject({ token: z.string().min(1) });
export const emailBodySchema = z.strictObject({ email: z.email() });
export const signInBodySchema = z.strictObject({
  email: z.email(),
  password: z.string(),
});
export const mfaChallengeBodySchema = z.strictObject({
  challengeToken: z.string().min(1),
  code: z.string().min(1),
  method: z.enum(['totp', 'recovery']),
});
export const resetPasswordBodySchema = z.strictObject({
  token: z.string().min(1),
  newPassword: z.string(),
});
export const changePasswordBodySchema = z.strictObject({
  currentPassword: z.string(),
  newPassword: z.string(),
});
export const requestEmailChangeBodySchema = z.strictObject({
  email: z.email(),
});
export const mfaCodeBodySchema = z.strictObject({ code: z.string().min(1) });
export const stepUpBodySchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('password'), password: z.string() }),
  z.strictObject({ method: z.literal('totp'), code: z.string() }),
]);
export const deletionRequestBodySchema = z.strictObject({
  reason: z.string().trim().max(1000).optional(),
});

export const authMessageResponseSchema = z.strictObject({
  message: z.string(),
});
export const authStatusResponseSchema = z.strictObject({ status: z.string() });
export const authSignInResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('session') }),
  z.strictObject({ status: z.literal('enrollment_required') }),
  z.strictObject({
    status: z.literal('mfa_required'),
    challengeToken: z.string(),
  }),
]);
export const authLegalResponseSchema = z.strictObject({
  terms: z.strictObject({ version: z.string(), text: z.string() }),
  privacy: z.strictObject({ version: z.string(), text: z.string() }),
});
export const mfaEnrollmentResponseSchema = z.strictObject({
  manualKey: z.string(),
  otpauthUrl: z.string(),
});
export const recoveryCodesResponseSchema = z.strictObject({
  codes: z.array(z.string()).length(10),
});
export const sessionsResponseSchema = z.strictObject({
  sessions: z.array(
    z.strictObject({
      id: z.uuid(),
      kind: z.enum(['cookie', 'bearer']),
      client: z.enum(['web', 'ios', 'android']),
      createdAt: z.iso.datetime(),
      lastSeenAt: z.iso.datetime(),
      idleExpiresAt: z.iso.datetime(),
      absoluteExpiresAt: z.iso.datetime(),
      ip: z.string().nullable(),
      userAgent: z.string().nullable(),
      current: z.boolean(),
    }),
  ),
});
export const deletionRequestResponseSchema = z.strictObject({
  requestId: z.uuid(),
});
