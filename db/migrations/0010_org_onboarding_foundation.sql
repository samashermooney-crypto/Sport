INSERT INTO plans (id, key, name, monthly_price_cents, application_fee_bps, application_fee_fixed_cents, limits)
VALUES
  ('01a0e077-1f46-75de-90e0-731321c696c7', 'starter', 'Starter', 0, 150, 0, '{"customPricing":false}'::jsonb),
  ('01a0e077-1f46-75de-90e0-76bce05ecaf2', 'pro', 'Pro', 9900, 75, 0, '{"customPricing":false}'::jsonb),
  ('01a0e077-1f46-75de-90e0-79619a4d88df', 'enterprise', 'Enterprise', 0, 0, 0, '{"customPricing":true}'::jsonb);

CREATE TABLE sport_templates (
  id uuid PRIMARY KEY,
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name text NOT NULL,
  profile jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER sport_templates_set_updated_at BEFORE UPDATE ON sport_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT ON sport_templates TO athlentry_app;

CREATE TABLE sport_profiles (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  template_key text REFERENCES sport_templates(key),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  profile jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, template_key)
);
CREATE INDEX sport_profiles_org_active_idx ON sport_profiles (org_id, archived_at);
CREATE TRIGGER sport_profiles_set_updated_at BEFORE UPDATE ON sport_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE sport_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE sport_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY sport_profiles_scope ON sport_profiles TO athlentry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON sport_profiles TO athlentry_app;

CREATE TABLE seasons (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'active', 'completed', 'archived')),
  copied_from_season_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, copied_from_season_id) REFERENCES seasons(org_id, id),
  CHECK (starts_on <= ends_on)
);
CREATE INDEX seasons_org_status_idx ON seasons (org_id, status, starts_on DESC);
CREATE TRIGGER seasons_set_updated_at BEFORE UPDATE ON seasons FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE seasons FORCE ROW LEVEL SECURITY;
CREATE POLICY seasons_scope ON seasons TO athlentry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON seasons TO athlentry_app;

CREATE TABLE credential_types (
  id uuid PRIMARY KEY,
  org_id uuid REFERENCES organizations(id),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  description text,
  verification text NOT NULL CHECK (verification IN ('document_upload', 'attestation', 'provider', 'manual_staff')),
  provider text CHECK (provider IS NULL OR provider IN ('checkr')),
  validity jsonb NOT NULL,
  applies_to jsonb NOT NULL,
  blocks_activation boolean NOT NULL DEFAULT false,
  renewal_reminder_days integer[] NOT NULL DEFAULT ARRAY[30, 14, 3],
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE NULLS NOT DISTINCT (org_id, key)
);
CREATE INDEX credential_types_org_active_idx ON credential_types (org_id, active);
CREATE TRIGGER credential_types_set_updated_at BEFORE UPDATE ON credential_types FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE credential_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_types FORCE ROW LEVEL SECURITY;
CREATE POLICY credential_types_read ON credential_types FOR SELECT TO athlentry_app
  USING (org_id IS NULL OR org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY credential_types_insert ON credential_types FOR INSERT TO athlentry_app
  WITH CHECK (org_id IS NOT NULL AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY credential_types_update ON credential_types FOR UPDATE TO athlentry_app
  USING (org_id IS NOT NULL AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id IS NOT NULL AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON credential_types TO athlentry_app;

CREATE TABLE form_definitions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  scope text NOT NULL CHECK (scope IN ('person_profile', 'registration', 'team_entry', 'volunteer', 'evaluation', 'incident', 'custom')),
  owner_type text NOT NULL DEFAULT 'org',
  owner_id uuid,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  schema jsonb NOT NULL,
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK ((owner_type = 'org' AND owner_id IS NULL) OR (owner_type <> 'org' AND owner_id IS NOT NULL))
);
CREATE INDEX form_definitions_org_scope_idx ON form_definitions (org_id, scope, published_at);
CREATE TRIGGER form_definitions_set_updated_at BEFORE UPDATE ON form_definitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE form_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY form_definitions_scope ON form_definitions TO athlentry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON form_definitions TO athlentry_app;

CREATE TABLE waiver_documents (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  body_html text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  requires text NOT NULL CHECK (requires IN ('guardian_if_minor', 'participant', 'both')),
  renewal text NOT NULL CHECK (renewal IN ('every_registration', 'annual_season', 'once')),
  template_unreviewed boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (NOT template_unreviewed OR published_at IS NULL)
);
CREATE FUNCTION protect_unreviewed_waiver() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.template_unreviewed AND NOT NEW.template_unreviewed AND NEW.body_html = OLD.body_html THEN
    RAISE EXCEPTION 'The draft waiver text must be replaced before review is cleared';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER waiver_documents_protect_draft BEFORE UPDATE ON waiver_documents
  FOR EACH ROW EXECUTE FUNCTION protect_unreviewed_waiver();
CREATE INDEX waiver_documents_org_published_idx ON waiver_documents (org_id, published_at);
CREATE TRIGGER waiver_documents_set_updated_at BEFORE UPDATE ON waiver_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE waiver_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE waiver_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY waiver_documents_scope ON waiver_documents TO athlentry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON waiver_documents TO athlentry_app;
