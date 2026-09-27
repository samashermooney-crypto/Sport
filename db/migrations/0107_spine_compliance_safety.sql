CREATE TABLE role_credential_requirements (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  role text NOT NULL CHECK (role IN ('head_coach', 'assistant_coach', 'team_manager', 'trainer', 'treasurer', 'official', 'volunteer', 'evaluator')),
  credential_type_id uuid NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('org', 'program')),
  scope_id uuid,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE NULLS NOT DISTINCT (org_id, role, credential_type_id, scope_type, scope_id),
  CHECK ((scope_type = 'org' AND scope_id IS NULL) OR (scope_type = 'program' AND scope_id IS NOT NULL)),
  FOREIGN KEY (org_id, credential_type_id) REFERENCES credential_types(org_id, id),
  FOREIGN KEY (org_id, scope_id) REFERENCES programs(org_id, id)
);
CREATE INDEX role_credential_requirements_role_idx ON role_credential_requirements(org_id, role, active);
CREATE INDEX role_credential_requirements_type_idx ON role_credential_requirements(org_id, credential_type_id);
SELECT configure_spine_tenant_table('role_credential_requirements');

CREATE TABLE person_credentials (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  person_id uuid NOT NULL,
  credential_type_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'verified', 'rejected', 'expired', 'revoked')),
  identifier_enc bytea,
  issued_on date,
  expires_on date,
  file_id uuid,
  verified_by uuid REFERENCES accounts(id),
  verified_at timestamptz,
  rejection_reason text,
  provider_reference text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (issued_on IS NULL OR expires_on IS NULL OR issued_on <= expires_on),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, credential_type_id) REFERENCES credential_types(org_id, id)
);
CREATE INDEX person_credentials_person_idx ON person_credentials(org_id, person_id, status);
CREATE INDEX person_credentials_type_idx ON person_credentials(org_id, credential_type_id, status);
CREATE INDEX person_credentials_expiry_idx ON person_credentials(org_id, expires_on) WHERE status = 'verified';
SELECT configure_spine_tenant_table('person_credentials');

CREATE TABLE background_check_orders (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  person_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('manual', 'checkr')),
  package text NOT NULL,
  status text NOT NULL DEFAULT 'consent_pending' CHECK (status IN ('consent_pending', 'invited', 'in_progress', 'clear', 'consider', 'suspended', 'canceled', 'expired')),
  consent_signed_at timestamptz,
  disclosure_version text,
  provider_candidate_id text,
  provider_report_id text,
  result_summary text CHECK (result_summary IN ('clear', 'consider', 'adverse_action')),
  details_enc bytea,
  adjudication text NOT NULL DEFAULT 'pending' CHECK (adjudication IN ('eligible', 'ineligible', 'pending')),
  adjudicated_by uuid REFERENCES accounts(id),
  adjudicated_at timestamptz,
  pre_adverse_notice_at timestamptz,
  adverse_notice_at timestamptz,
  completed_at timestamptz,
  credential_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (status = 'consent_pending' OR consent_signed_at IS NOT NULL),
  CHECK (adverse_notice_at IS NULL OR pre_adverse_notice_at IS NOT NULL),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, credential_id) REFERENCES person_credentials(org_id, id)
);
CREATE INDEX background_check_orders_person_idx ON background_check_orders(org_id, person_id, status);
CREATE INDEX background_check_orders_provider_idx ON background_check_orders(org_id, provider, status);
CREATE INDEX background_check_orders_credential_idx ON background_check_orders(org_id, credential_id) WHERE credential_id IS NOT NULL;
SELECT configure_spine_tenant_table('background_check_orders');

CREATE TABLE injury_reports (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  person_id uuid NOT NULL,
  event_id uuid,
  occurred_at timestamptz NOT NULL,
  body_part text,
  injury_type text,
  is_suspected_concussion boolean NOT NULL DEFAULT false,
  description_enc bytea,
  reported_by uuid NOT NULL REFERENCES accounts(id),
  guardian_notified_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'return_to_play_pending', 'cleared', 'closed')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id)
);
CREATE INDEX injury_reports_person_idx ON injury_reports(org_id, person_id, status, occurred_at DESC);
CREATE INDEX injury_reports_event_idx ON injury_reports(org_id, event_id) WHERE event_id IS NOT NULL;
SELECT configure_spine_tenant_table('injury_reports');

CREATE FUNCTION block_roster_on_concussion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_suspected_concussion AND NEW.status IN ('open', 'return_to_play_pending') THEN
    UPDATE roster_entries SET status = 'injured', version = version + 1
    WHERE org_id = NEW.org_id AND person_id = NEW.person_id AND status = 'active';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER injury_reports_block_roster AFTER INSERT OR UPDATE OF is_suspected_concussion, status ON injury_reports
  FOR EACH ROW EXECUTE FUNCTION block_roster_on_concussion();

CREATE TABLE return_to_play_clearances (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  injury_report_id uuid NOT NULL,
  clearance_file_id uuid NOT NULL,
  cleared_by_provider_name text NOT NULL,
  cleared_on date NOT NULL,
  recorded_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, injury_report_id),
  FOREIGN KEY (org_id, injury_report_id) REFERENCES injury_reports(org_id, id)
);
SELECT configure_spine_tenant_table('return_to_play_clearances', true);

CREATE TABLE incident_reports (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  category text NOT NULL CHECK (category IN ('safety', 'behavior', 'safesport_concern', 'facility', 'other')),
  occurred_at timestamptz NOT NULL,
  event_id uuid,
  people_involved uuid[] NOT NULL DEFAULT '{}',
  narrative_enc bytea NOT NULL,
  reported_by uuid NOT NULL REFERENCES accounts(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'under_review', 'closed')),
  restricted boolean NOT NULL DEFAULT false,
  resolution_enc bytea,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (category <> 'safesport_concern' OR restricted),
  FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id)
);
CREATE INDEX incident_reports_status_idx ON incident_reports(org_id, status, occurred_at DESC);
CREATE INDEX incident_reports_event_idx ON incident_reports(org_id, event_id) WHERE event_id IS NOT NULL;
SELECT configure_spine_tenant_table('incident_reports');

CREATE TABLE athlete_cards (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  person_id uuid NOT NULL,
  program_id uuid,
  season_id uuid,
  card_number text NOT NULL,
  qr_secret bytea NOT NULL,
  photo_file_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  valid_until date NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, card_number),
  CHECK ((program_id IS NOT NULL) <> (season_id IS NOT NULL)),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id),
  FOREIGN KEY (org_id, season_id) REFERENCES seasons(org_id, id)
);
CREATE INDEX athlete_cards_person_idx ON athlete_cards(org_id, person_id, status);
CREATE INDEX athlete_cards_program_idx ON athlete_cards(org_id, program_id) WHERE program_id IS NOT NULL;
CREATE INDEX athlete_cards_season_idx ON athlete_cards(org_id, season_id) WHERE season_id IS NOT NULL;
SELECT configure_spine_tenant_table('athlete_cards');
