ALTER TABLE sessions ADD COLUMN privileged boolean NOT NULL DEFAULT false;

ALTER TABLE auth_tokens DROP CONSTRAINT auth_tokens_purpose_check;
ALTER TABLE auth_tokens ADD CONSTRAINT auth_tokens_purpose_check CHECK (
  purpose IN ('verify_email', 'magic_link', 'reset_password', 'org_invitation',
              'guardian_invitation', 'athlete_account_invitation', 'claim_person',
              'email_change', 'mfa_challenge')
);

CREATE TABLE privacy_requests (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  kind text NOT NULL CHECK (kind = 'account_deletion'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'completed', 'rejected')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX privacy_requests_open_idx ON privacy_requests (account_id, kind)
  WHERE status IN ('pending', 'in_review');
CREATE TRIGGER privacy_requests_set_updated_at BEFORE UPDATE ON privacy_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE ON privacy_requests TO athlentry_app;
