ALTER TABLE role_credential_requirements
  ADD COLUMN minimum_age smallint NOT NULL DEFAULT 18 CHECK (minimum_age BETWEEN 0 AND 120);

CREATE TABLE compliance_overrides (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  person_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('head_coach', 'assistant_coach', 'team_manager', 'trainer', 'treasurer', 'official', 'volunteer', 'evaluator')),
  scope_type text NOT NULL CHECK (scope_type IN ('org', 'program')),
  scope_id uuid,
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  approved_by uuid NOT NULL REFERENCES accounts(id),
  granted_on date NOT NULL,
  expires_on date NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES accounts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK ((scope_type = 'org' AND scope_id IS NULL) OR (scope_type = 'program' AND scope_id IS NOT NULL)),
  CHECK (expires_on >= granted_on AND expires_on <= granted_on + 14),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, scope_id) REFERENCES programs(org_id, id)
);
CREATE INDEX compliance_overrides_active_idx ON compliance_overrides(org_id, person_id, role, expires_on) WHERE revoked_at IS NULL;
SELECT configure_spine_tenant_table('compliance_overrides');

CREATE TABLE credential_reminder_events (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  person_credential_id uuid NOT NULL,
  expires_on date NOT NULL,
  days_before integer NOT NULL CHECK (days_before >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, person_credential_id, expires_on, days_before),
  FOREIGN KEY (org_id, person_credential_id) REFERENCES person_credentials(org_id, id)
);
CREATE INDEX credential_reminder_events_credential_idx ON credential_reminder_events(org_id, person_credential_id, created_at DESC);
SELECT configure_spine_tenant_table('credential_reminder_events', true);

CREATE TABLE background_check_settings (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL UNIQUE REFERENCES organizations(id),
  provider_mode text NOT NULL DEFAULT 'manual' CHECK (provider_mode IN ('manual', 'checkr')),
  checkr_enabled boolean NOT NULL DEFAULT false,
  volunteer_pays_fee boolean NOT NULL DEFAULT false,
  package text NOT NULL DEFAULT 'basic' CHECK (length(trim(package)) > 0),
  disclosure_version text,
  disclosure_text text,
  authorization_version text,
  authorization_text text,
  pre_adverse_notice_text text,
  rights_summary_text text,
  adverse_notice_text text,
  fcra_holidays date[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (provider_mode <> 'checkr' OR checkr_enabled)
);
SELECT configure_spine_tenant_table('background_check_settings');

ALTER TABLE background_check_orders
  ADD COLUMN authorization_version text,
  ADD COLUMN authorization_text text,
  ADD COLUMN consent_ip inet,
  ADD COLUMN consent_user_agent text;
CREATE INDEX background_check_orders_adjudication_idx ON background_check_orders(org_id, status, adjudication, completed_at DESC);

CREATE TABLE background_check_webhook_events (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  provider_event_id text NOT NULL,
  report_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, provider_event_id)
);
CREATE INDEX background_check_webhook_report_idx ON background_check_webhook_events(org_id, report_id);
SELECT configure_spine_tenant_table('background_check_webhook_events', true);

ALTER TABLE person_credentials
  ADD COLUMN identifier_hint text,
  ADD CONSTRAINT person_credentials_file_fk FOREIGN KEY (org_id, file_id) REFERENCES files(org_id, id);

ALTER TABLE return_to_play_clearances
  ADD COLUMN review_status text NOT NULL DEFAULT 'pending_review' CHECK (review_status IN ('pending_review', 'approved', 'rejected')),
  ADD COLUMN reviewed_by uuid REFERENCES accounts(id),
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN rejection_reason text,
  ADD CONSTRAINT return_to_play_clearances_file_fk FOREIGN KEY (org_id, clearance_file_id) REFERENCES files(org_id, id);
CREATE INDEX return_to_play_review_idx ON return_to_play_clearances(org_id, review_status, created_at);

CREATE TABLE injury_roster_holds (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  injury_report_id uuid NOT NULL,
  roster_entry_id uuid NOT NULL,
  former_status text NOT NULL CHECK (former_status IN ('active', 'suspended', 'inactive', 'released')),
  restored_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, injury_report_id, roster_entry_id),
  FOREIGN KEY (org_id, injury_report_id) REFERENCES injury_reports(org_id, id),
  FOREIGN KEY (org_id, roster_entry_id) REFERENCES roster_entries(org_id, id)
);
CREATE INDEX injury_roster_holds_roster_idx ON injury_roster_holds(org_id, roster_entry_id) WHERE restored_at IS NULL;
SELECT configure_spine_tenant_table('injury_roster_holds');

DROP TRIGGER injury_reports_block_roster ON injury_reports;
CREATE OR REPLACE FUNCTION block_roster_on_concussion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_suspected_concussion AND NEW.status IN ('open', 'return_to_play_pending') THEN
    INSERT INTO injury_roster_holds (id, org_id, injury_report_id, roster_entry_id, former_status)
    SELECT gen_random_uuid(), NEW.org_id, NEW.id, roster.id, roster.status
    FROM roster_entries AS roster
    WHERE roster.org_id = NEW.org_id
      AND roster.person_id = NEW.person_id
      AND roster.status = 'active'
    ON CONFLICT (org_id, injury_report_id, roster_entry_id) DO NOTHING;
    UPDATE roster_entries SET status = 'injured', version = version + 1
    WHERE org_id = NEW.org_id AND person_id = NEW.person_id AND status = 'active';
  END IF;
  IF NEW.status = 'cleared' AND OLD.status <> 'cleared' THEN
    UPDATE roster_entries AS roster
    SET status = holds.former_status, version = roster.version + 1
    FROM injury_roster_holds AS holds
    WHERE holds.org_id = NEW.org_id
      AND holds.injury_report_id = NEW.id
      AND holds.roster_entry_id = roster.id
      AND holds.restored_at IS NULL
      AND roster.status = 'injured'
      AND NOT EXISTS (
        SELECT 1 FROM injury_reports AS other
        WHERE other.org_id = NEW.org_id
          AND other.person_id = NEW.person_id
          AND other.id <> NEW.id
          AND other.is_suspected_concussion
          AND other.status IN ('open', 'return_to_play_pending')
      );
    UPDATE injury_roster_holds
    SET restored_at = now(), version = version + 1
    WHERE org_id = NEW.org_id AND injury_report_id = NEW.id AND restored_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER injury_reports_block_roster AFTER INSERT OR UPDATE OF is_suspected_concussion, status ON injury_reports
  FOR EACH ROW EXECUTE FUNCTION block_roster_on_concussion();

ALTER TABLE athlete_cards
  ADD COLUMN card_kind text NOT NULL DEFAULT 'player' CHECK (card_kind IN ('player', 'staff')),
  ADD CONSTRAINT athlete_cards_photo_fk FOREIGN KEY (org_id, photo_file_id) REFERENCES files(org_id, id);
