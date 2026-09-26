CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  email citext NOT NULL UNIQUE,
  email_verified_at timestamptz,
  password_hash text,
  first_name text NOT NULL CHECK (length(trim(first_name)) > 0),
  last_name text NOT NULL CHECK (length(trim(last_name)) > 0),
  phone_e164 text,
  phone_verified_at timestamptz,
  locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'es')),
  timezone text,
  date_of_birth date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'locked', 'deactivated', 'anonymized')),
  last_sign_in_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER accounts_set_updated_at BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE account_consents (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  kind text NOT NULL CHECK (kind IN ('terms', 'privacy')),
  document_version text NOT NULL,
  document_text text NOT NULL,
  ip inet,
  user_agent text,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, kind, document_version)
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  account_id uuid NOT NULL REFERENCES accounts(id),
  kind text NOT NULL CHECK (kind IN ('cookie', 'bearer')),
  client text NOT NULL CHECK (client IN ('web', 'ios', 'android')),
  elevated_until timestamptz,
  mfa_verified_at timestamptz,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  ip inet,
  user_agent text,
  revoked_at timestamptz,
  impersonation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (idle_expires_at <= absolute_expires_at)
);
CREATE INDEX sessions_account_active_idx ON sessions (account_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE TRIGGER sessions_set_updated_at BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE mfa_factors (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  type text NOT NULL CHECK (type = 'totp'),
  secret_enc bytea NOT NULL,
  confirmed_at timestamptz,
  last_used_step bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, type)
);
CREATE TRIGGER mfa_factors_set_updated_at BEFORE UPDATE ON mfa_factors FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE mfa_recovery_codes (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  code_hash bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, code_hash)
);

CREATE TABLE auth_tokens (
  id uuid PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('verify_email', 'magic_link', 'reset_password', 'org_invitation', 'guardian_invitation', 'athlete_account_invitation', 'claim_person', 'email_change')),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  account_id uuid REFERENCES accounts(id),
  email citext NOT NULL,
  org_id uuid REFERENCES organizations(id),
  subject_key text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_by uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX auth_tokens_live_subject_idx ON auth_tokens (purpose, email, org_id, subject_key) NULLS NOT DISTINCT
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX auth_tokens_expiry_idx ON auth_tokens (expires_at);

CREATE TABLE org_memberships (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  status text NOT NULL CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
  title text,
  invited_by uuid REFERENCES accounts(id),
  joined_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, account_id)
);
CREATE INDEX org_memberships_account_idx ON org_memberships (account_id, status);
CREATE TRIGGER org_memberships_set_updated_at BEFORE UPDATE ON org_memberships FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE role_assignments (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  account_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'registrar', 'finance', 'scheduler', 'compliance', 'communications', 'director', 'evaluator', 'volunteer_coordinator', 'reporter')),
  scope_type text NOT NULL CHECK (scope_type IN ('org', 'season', 'program', 'division', 'team_season')),
  scope_id uuid,
  granted_by uuid REFERENCES accounts(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  pending_mfa boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, account_id) REFERENCES org_memberships (org_id, account_id),
  CHECK ((scope_type = 'org' AND scope_id IS NULL) OR (scope_type <> 'org' AND scope_id IS NOT NULL))
);
CREATE UNIQUE INDEX role_assignments_active_idx ON role_assignments (org_id, account_id, role, scope_type, scope_id) NULLS NOT DISTINCT
  WHERE revoked_at IS NULL;
CREATE INDEX role_assignments_account_idx ON role_assignments (account_id, revoked_at);
CREATE TRIGGER role_assignments_set_updated_at BEFORE UPDATE ON role_assignments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE device_tokens (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  platform text NOT NULL CHECK (platform IN ('webpush', 'apns', 'fcm')),
  token_or_subscription jsonb NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_tokens_account_idx ON device_tokens (account_id, revoked_at);
CREATE TRIGGER device_tokens_set_updated_at BEFORE UPDATE ON device_tokens FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE security_events (
  id uuid PRIMARY KEY,
  account_id uuid REFERENCES accounts(id),
  action text NOT NULL,
  ip inet,
  user_agent text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_events_account_created_idx ON security_events (account_id, created_at DESC);

ALTER TABLE auth_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_tokens_scope ON auth_tokens TO athlentry_app
  USING (org_id IS NULL OR org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id IS NULL OR org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE org_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY org_memberships_isolation ON org_memberships TO athlentry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY role_assignments_isolation ON role_assignments TO athlentry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON accounts, sessions, mfa_factors, mfa_recovery_codes, auth_tokens, org_memberships, role_assignments, device_tokens TO athlentry_app;
GRANT DELETE ON sessions, mfa_recovery_codes, device_tokens TO athlentry_app;
GRANT SELECT, INSERT ON account_consents, security_events TO athlentry_app;
