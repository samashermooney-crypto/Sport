ALTER TABLE auth_tokens DROP CONSTRAINT auth_tokens_purpose_check;
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_purpose_check CHECK (
  purpose IN ('verify_email', 'magic_link', 'reset_password', 'org_invitation',
              'guardian_invitation', 'athlete_account_invitation', 'claim_person',
              'email_change', 'mfa_challenge', 'ownership_transfer')
);
