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
]);

export const authTokenPayloadSchema = z.record(z.string(), z.json());

export type AuthTokenPurpose = z.infer<typeof authTokenPurposeSchema>;
