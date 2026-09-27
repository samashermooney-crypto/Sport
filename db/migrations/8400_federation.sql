CREATE TABLE org_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_org_id uuid NOT NULL REFERENCES organizations(id),
  child_org_id uuid NOT NULL REFERENCES organizations(id),
  status text NOT NULL CHECK (status IN ('pending_child', 'pending_parent', 'active', 'ended', 'declined')),
  invited_email citext,
  data_sharing jsonb NOT NULL DEFAULT '{"rosters":false,"staffCompliance":false,"availability":false,"discipline":false}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES accounts(id),
  accepted_by uuid REFERENCES accounts(id),
  accepted_at timestamptz,
  ended_by uuid REFERENCES accounts(id),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (parent_org_id, child_org_id),
  CHECK (parent_org_id <> child_org_id),
  CHECK ((status = 'active' AND accepted_at IS NOT NULL) OR status <> 'active'),
  CHECK ((status = 'ended' AND ended_at IS NOT NULL) OR status <> 'ended'),
  CHECK (jsonb_typeof(data_sharing) = 'object')
);
CREATE INDEX org_relationships_parent_idx ON org_relationships(parent_org_id, status, created_at DESC);
CREATE INDEX org_relationships_child_idx ON org_relationships(child_org_id, status, created_at DESC);
CREATE TRIGGER org_relationships_set_updated_at BEFORE UPDATE ON org_relationships FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE org_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_relationships FORCE ROW LEVEL SECURITY;
CREATE POLICY org_relationships_scope ON org_relationships TO athlentry_app
  USING (
    parent_org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    OR child_org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  )
  WITH CHECK (
    parent_org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
    OR child_org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  );
GRANT SELECT, INSERT, UPDATE ON org_relationships TO athlentry_app;

CREATE TABLE federation_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid NOT NULL,
  roster_submission_deadline timestamptz NOT NULL,
  roster_frozen_at timestamptz,
  entry_fee_cents bigint NOT NULL DEFAULT 0 CHECK (entry_fee_cents >= 0),
  fee_due_on date,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, program_id),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id)
);
CREATE INDEX federation_programs_deadline_idx ON federation_programs(org_id, roster_submission_deadline);
SELECT configure_spine_tenant_table('federation_programs');

CREATE TABLE federation_team_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  federation_program_id uuid NOT NULL,
  entrant_org_id uuid NOT NULL REFERENCES organizations(id),
  entrant_team_season_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'declined', 'withdrawn')),
  roster_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES accounts(id),
  approved_at timestamptz,
  invoice_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, federation_program_id, entrant_org_id, entrant_team_season_id),
  FOREIGN KEY (org_id, federation_program_id) REFERENCES federation_programs(org_id, id),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id),
  CHECK (jsonb_typeof(roster_snapshot) = 'array'),
  CHECK ((status = 'approved' AND approved_at IS NOT NULL) OR status <> 'approved')
);
CREATE INDEX federation_team_entries_program_idx ON federation_team_entries(org_id, federation_program_id, status);
CREATE INDEX federation_team_entries_entrant_idx ON federation_team_entries(org_id, entrant_org_id, status);
SELECT configure_spine_tenant_table('federation_team_entries');

CREATE TABLE federation_field_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  federation_program_id uuid NOT NULL,
  member_org_id uuid NOT NULL REFERENCES organizations(id),
  facility_id uuid NOT NULL,
  space_id uuid,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  submitted_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (starts_at < ends_at),
  FOREIGN KEY (org_id, federation_program_id) REFERENCES federation_programs(org_id, id)
);
CREATE INDEX federation_field_availability_slot_idx ON federation_field_availability(org_id, federation_program_id, starts_at, ends_at);
SELECT configure_spine_tenant_table('federation_field_availability');

CREATE TABLE federation_fixtures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  federation_program_id uuid NOT NULL,
  home_entry_id uuid NOT NULL,
  away_entry_id uuid NOT NULL,
  availability_id uuid NOT NULL,
  event_id uuid,
  starts_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'final', 'canceled')),
  home_score numeric(8,2),
  away_score numeric(8,2),
  result_entered_by uuid REFERENCES accounts(id),
  result_entered_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (home_entry_id <> away_entry_id),
  CHECK ((status = 'final' AND home_score IS NOT NULL AND away_score IS NOT NULL AND result_entered_at IS NOT NULL) OR status <> 'final'),
  FOREIGN KEY (org_id, federation_program_id) REFERENCES federation_programs(org_id, id),
  FOREIGN KEY (org_id, home_entry_id) REFERENCES federation_team_entries(org_id, id),
  FOREIGN KEY (org_id, away_entry_id) REFERENCES federation_team_entries(org_id, id),
  FOREIGN KEY (org_id, availability_id) REFERENCES federation_field_availability(org_id, id),
  FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id)
);
CREATE INDEX federation_fixtures_program_idx ON federation_fixtures(org_id, federation_program_id, starts_at, status);
SELECT configure_spine_tenant_table('federation_fixtures');

CREATE TABLE federation_discipline_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  federation_program_id uuid NOT NULL,
  member_org_id uuid NOT NULL REFERENCES organizations(id),
  entrant_team_season_id uuid NOT NULL,
  person_name text NOT NULL CHECK (length(trim(person_name)) > 0),
  record_type text NOT NULL CHECK (record_type IN ('caution', 'send_off', 'ejection', 'technical', 'suspension', 'fine', 'other')),
  status text NOT NULL CHECK (status IN ('active', 'served', 'appealed', 'overturned')),
  description text,
  suspension_games integer NOT NULL DEFAULT 0 CHECK (suspension_games >= 0),
  source_record_id uuid NOT NULL,
  reported_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, member_org_id, source_record_id),
  FOREIGN KEY (org_id, federation_program_id) REFERENCES federation_programs(org_id, id)
);
CREATE INDEX federation_discipline_program_idx ON federation_discipline_summaries(org_id, federation_program_id, status, created_at DESC);
SELECT configure_spine_tenant_table('federation_discipline_summaries');

CREATE TABLE federation_access_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  relationship_id uuid NOT NULL,
  viewer_org_id uuid NOT NULL REFERENCES organizations(id),
  subject_org_id uuid NOT NULL REFERENCES organizations(id),
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  dataset text NOT NULL CHECK (dataset IN ('rosters', 'staffCompliance', 'availability', 'discipline', 'dashboard')),
  fields text[] NOT NULL,
  row_count integer NOT NULL CHECK (row_count >= 0),
  accessed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (viewer_org_id <> subject_org_id)
);
CREATE INDEX federation_access_audits_subject_idx ON federation_access_audits(org_id, subject_org_id, accessed_at DESC);
-- Relationships span two tenants. The service verifies the relationship in both tenant-scoped reads before appending this audit row.
SELECT configure_spine_tenant_table('federation_access_audits', true);
