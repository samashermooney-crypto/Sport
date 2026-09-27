CREATE TABLE platform_staff (
  account_id uuid PRIMARY KEY REFERENCES accounts(id),
  role text NOT NULL CHECK (role IN ('super_admin', 'support', 'finance_ops')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_staff_active_idx ON platform_staff(role) WHERE active;
CREATE TRIGGER platform_staff_set_updated_at BEFORE UPDATE ON platform_staff FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE platform_feature_flags (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.-]{1,79}$'),
  description text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  organization_overrides jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(organization_overrides) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER platform_feature_flags_set_updated_at BEFORE UPDATE ON platform_feature_flags FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE platform_impersonations (
  id uuid PRIMARY KEY,
  staff_account_id uuid NOT NULL REFERENCES platform_staff(account_id),
  target_organization_id uuid NOT NULL REFERENCES organizations(id),
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 10 AND 500),
  read_only boolean NOT NULL DEFAULT true CHECK (read_only),
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz,
  CHECK (expires_at > started_at AND expires_at <= started_at + interval '60 minutes'),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE INDEX platform_impersonations_active_idx ON platform_impersonations(staff_account_id, expires_at) WHERE ended_at IS NULL;

CREATE TABLE platform_audit_log (
  id uuid PRIMARY KEY,
  staff_account_id uuid NOT NULL REFERENCES platform_staff(account_id),
  action text NOT NULL,
  target_organization_id uuid REFERENCES organizations(id),
  target_account_id uuid REFERENCES accounts(id),
  impersonation_id uuid REFERENCES platform_impersonations(id),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_log_created_idx ON platform_audit_log(created_at DESC);
CREATE INDEX platform_audit_log_org_idx ON platform_audit_log(target_organization_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON platform_staff, platform_feature_flags, platform_impersonations TO athlentry_app;
GRANT SELECT, INSERT ON platform_audit_log TO athlentry_app;
REVOKE UPDATE, DELETE ON platform_audit_log FROM athlentry_app;
