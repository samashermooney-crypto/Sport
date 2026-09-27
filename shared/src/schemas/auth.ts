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
