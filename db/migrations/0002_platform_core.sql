CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TABLE plans (
  id uuid PRIMARY KEY,
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  monthly_price_cents bigint NOT NULL CHECK (monthly_price_cents >= 0),
  stripe_price_id text,
  application_fee_bps integer NOT NULL CHECK (application_fee_bps BETWEEN 0 AND 10000),
  application_fee_fixed_cents bigint NOT NULL CHECK (application_fee_fixed_cents >= 0),
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  slug citext NOT NULL UNIQUE CHECK (length(slug::text) BETWEEN 3 AND 40 AND slug::text ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  legal_name text,
  kind text NOT NULL CHECK (kind IN ('club', 'league', 'association', 'academy', 'school', 'parks_rec', 'tournament_operator', 'other')),
  timezone text NOT NULL,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  default_locale text NOT NULL DEFAULT 'en' CHECK (default_locale IN ('en', 'es')),
  country text NOT NULL DEFAULT 'US' CHECK (country = 'US'),
  address jsonb,
  phone text,
  email citext,
  website_url text,
  logo_file_id uuid,
  brand jsonb NOT NULL DEFAULT '{}'::jsonb,
  nonprofit boolean NOT NULL DEFAULT false,
  ein_enc bytea,
  status text NOT NULL DEFAULT 'onboarding' CHECK (status IN ('onboarding', 'active', 'suspended', 'closed')),
  plan_id uuid REFERENCES plans(id),
  application_fee_bps integer NOT NULL DEFAULT 150 CHECK (application_fee_bps BETWEEN 0 AND 10000),
  application_fee_fixed_cents bigint NOT NULL DEFAULT 0 CHECK (application_fee_fixed_cents >= 0),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_counters (
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (name IN ('invoice', 'order', 'receipt', 'donation_receipt', 'bib')),
  next_value bigint NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, name)
);

CREATE TABLE idempotency_keys (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  actor_id uuid NOT NULL,
  key uuid NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, actor_id, key)
);
CREATE INDEX idempotency_keys_created_at_idx ON idempotency_keys (created_at);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  org_id uuid REFERENCES organizations(id),
  actor_account_id uuid,
  impersonation_id uuid,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip inet,
  user_agent text,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX audit_log_org_created_idx ON audit_log (org_id, created_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (org_id, entity_type, entity_id);

CREATE TRIGGER plans_set_updated_at BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER organizations_set_updated_at BEFORE UPDATE ON organizations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER org_counters_set_updated_at BEFORE UPDATE ON org_counters FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER idempotency_keys_set_updated_at BEFORE UPDATE ON idempotency_keys FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE org_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY org_counters_isolation ON org_counters TO athlentry_app
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_keys_isolation ON idempotency_keys TO athlentry_app
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_isolation ON audit_log TO athlentry_app
  USING (org_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON plans, organizations, org_counters, idempotency_keys TO athlentry_app;
GRANT SELECT, INSERT ON audit_log TO athlentry_app;
REVOKE UPDATE, DELETE ON audit_log FROM athlentry_app;
