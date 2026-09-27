-- Track J / Phase 13: federation (associations, leagues, member clubs).
--
-- org_relationships and federation_event_links are shared two-org tables: they
-- carry no org_id column, so configure_spine_tenant_table cannot be used. Each
-- gets an explicit policy granting row access to BOTH participating orgs.
-- All other federation tables are single-org tenant tables (org_id = the org
-- that owns the record: league for snapshots/discipline/fees, club for
-- contributed availability).

CREATE FUNCTION federation_sharing_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  bad_key text;
  bad_value text;
BEGIN
  IF jsonb_typeof(NEW.data_sharing) <> 'object' THEN
    RAISE EXCEPTION 'data_sharing must be an object';
  END IF;
  SELECT k INTO bad_key FROM jsonb_object_keys(NEW.data_sharing) k
    WHERE k NOT IN ('rosters', 'complianceStatus', 'teamEntries', 'discipline')
    LIMIT 1;
  IF bad_key IS NOT NULL THEN
    RAISE EXCEPTION 'data_sharing key % is not permitted', bad_key;
  END IF;
  SELECT k INTO bad_value FROM jsonb_each(NEW.data_sharing) e(k, v)
    WHERE jsonb_typeof(e.v) <> 'boolean' LIMIT 1;
  IF bad_value IS NOT NULL THEN
    RAISE EXCEPTION 'data_sharing values must be boolean';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE org_relationships (
  id uuid PRIMARY KEY,
  parent_org_id uuid NOT NULL REFERENCES organizations(id),
  child_org_id uuid NOT NULL REFERENCES organizations(id),
  type text NOT NULL CHECK (type IN ('member_club', 'affiliate')),
  initiator text NOT NULL CHECK (initiator IN ('parent', 'child')),
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'suspended', 'ended')),
  data_sharing jsonb NOT NULL DEFAULT '{}'::jsonb,
  pending_data_sharing jsonb,
  pending_sharing_by uuid REFERENCES accounts(id),
  initiated_by_account_id uuid NOT NULL REFERENCES accounts(id),
  note text,
  responded_at timestamptz,
  suspended_at timestamptz,
  suspended_by_account_id uuid REFERENCES accounts(id),
  suspend_reason text,
  ended_at timestamptz,
  ended_by_account_id uuid REFERENCES accounts(id),
  end_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_org_id <> child_org_id)
);
CREATE UNIQUE INDEX org_relationships_live_pair_idx
  ON org_relationships(parent_org_id, child_org_id)
  WHERE status IN ('invited', 'active', 'suspended');
CREATE INDEX org_relationships_child_idx ON org_relationships(child_org_id, status);
CREATE INDEX org_relationships_parent_idx ON org_relationships(parent_org_id, status);
ALTER TABLE org_relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_relationships FORCE ROW LEVEL SECURITY;
CREATE POLICY org_relationships_scope ON org_relationships TO athlentry_app
  USING (NULLIF(current_setting('app.org_id', true), '')::uuid IN (parent_org_id, child_org_id))
  WITH CHECK (NULLIF(current_setting('app.org_id', true), '')::uuid IN (parent_org_id, child_org_id));
CREATE TRIGGER org_relationships_set_updated_at BEFORE UPDATE ON org_relationships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER org_relationships_sharing_guard BEFORE INSERT OR UPDATE ON org_relationships
  FOR EACH ROW EXECUTE FUNCTION federation_sharing_guard();
GRANT SELECT, INSERT, UPDATE ON org_relationships TO athlentry_app;

CREATE FUNCTION org_relationships_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_org_id IS DISTINCT FROM OLD.parent_org_id
    OR NEW.child_org_id IS DISTINCT FROM OLD.child_org_id
    OR NEW.type IS DISTINCT FROM OLD.type
    OR NEW.initiator IS DISTINCT FROM OLD.initiator THEN
    RAISE EXCEPTION 'org_relationships parties are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER org_relationships_immutable BEFORE UPDATE ON org_relationships
  FOR EACH ROW EXECUTE FUNCTION org_relationships_immutable_guard();

-- Roster submission windows declared by the league org per program.
CREATE TABLE federation_roster_windows (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid NOT NULL,
  submit_by timestamptz NOT NULL,
  freeze_at timestamptz,
  created_by uuid NOT NULL REFERENCES accounts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, program_id),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id)
);
SELECT configure_spine_tenant_table('federation_roster_windows');

-- Immutable-ish allow-listed roster snapshots submitted with league team entries.
-- Live snapshot per entry enforced by partial unique index; resubmits supersede.
CREATE TABLE federation_roster_snapshots (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  team_entry_id uuid NOT NULL,
  member_org_id uuid NOT NULL REFERENCES organizations(id),
  source_team_season_id uuid NOT NULL,
  roster jsonb NOT NULL,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'frozen', 'superseded')),
  submitted_by uuid NOT NULL REFERENCES accounts(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  frozen_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, team_entry_id) REFERENCES team_entries(org_id, id)
);
CREATE UNIQUE INDEX federation_roster_snapshots_live_idx
  ON federation_roster_snapshots(org_id, team_entry_id) WHERE status <> 'superseded';
CREATE INDEX federation_roster_snapshots_member_idx
  ON federation_roster_snapshots(org_id, member_org_id, status);
SELECT configure_spine_tenant_table('federation_roster_snapshots');

-- Availability windows a member club contributes to the league schedule pool.
-- Lives in the CLUB org so RLS keeps club-owned; the league reads it only via
-- the privileged federation service (audited in both orgs).
CREATE TABLE federation_space_contributions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  relationship_id uuid NOT NULL REFERENCES org_relationships(id),
  space_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'withdrawn')),
  notes text,
  created_by uuid NOT NULL REFERENCES accounts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (starts_at < ends_at),
  FOREIGN KEY (org_id, space_id) REFERENCES spaces(org_id, id)
);
CREATE INDEX federation_space_contributions_window_idx
  ON federation_space_contributions(org_id, relationship_id, starts_at) WHERE status = 'offered';
CREATE INDEX federation_space_contributions_rel_idx
  ON federation_space_contributions(relationship_id) WHERE status = 'offered';
SELECT configure_spine_tenant_table('federation_space_contributions');

-- Links a league-scheduled contest hosted at a member club: the league event
-- (canonical), the mirror event + booking in the club org, and the leaf spaces
-- claimed there. Visible to both orgs.
CREATE TABLE federation_event_links (
  id uuid PRIMARY KEY,
  league_org_id uuid NOT NULL REFERENCES organizations(id),
  club_org_id uuid NOT NULL REFERENCES organizations(id),
  relationship_id uuid NOT NULL REFERENCES org_relationships(id),
  league_event_id uuid NOT NULL REFERENCES events(id),
  club_event_id uuid NOT NULL REFERENCES events(id),
  booking_group_id uuid NOT NULL,
  leaf_space_ids uuid[] NOT NULL DEFAULT '{}',
  during tstzrange NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (league_org_id <> club_org_id),
  CHECK (NOT isempty(during))
);
CREATE UNIQUE INDEX federation_event_links_league_event_idx
  ON federation_event_links(league_event_id) WHERE status = 'active';
CREATE INDEX federation_event_links_club_idx
  ON federation_event_links(club_org_id, during) WHERE status = 'active';
CREATE INDEX federation_event_links_league_idx
  ON federation_event_links(league_org_id, during) WHERE status = 'active';
ALTER TABLE federation_event_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE federation_event_links FORCE ROW LEVEL SECURITY;
CREATE POLICY federation_event_links_scope ON federation_event_links TO athlentry_app
  USING (NULLIF(current_setting('app.org_id', true), '')::uuid IN (league_org_id, club_org_id))
  WITH CHECK (NULLIF(current_setting('app.org_id', true), '')::uuid IN (league_org_id, club_org_id));
CREATE TRIGGER federation_event_links_set_updated_at BEFORE UPDATE ON federation_event_links
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE ON federation_event_links TO athlentry_app;

-- League-issued discipline against member-club subjects. The subject person
-- lives in the club org, so person subjects are recorded as an opaque ref plus
-- a display label captured at issue time; team subjects reference the
-- league-side external_teams row.
CREATE TABLE federation_discipline_records (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  member_org_id uuid NOT NULL REFERENCES organizations(id),
  contest_id uuid,
  external_team_id uuid,
  subject_type text NOT NULL CHECK (subject_type IN ('team', 'person')),
  person_ref uuid,
  person_label text,
  type text NOT NULL CHECK (type IN ('caution', 'send_off', 'ejection', 'technical', 'suspension', 'fine', 'other')),
  description text NOT NULL CHECK (length(trim(description)) > 0),
  suspension_games integer CHECK (suspension_games IS NULL OR suspension_games >= 0),
  suspension_until date,
  games_served integer NOT NULL DEFAULT 0 CHECK (games_served >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'served', 'appealed', 'overturned')),
  issued_by uuid NOT NULL REFERENCES accounts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (
    (subject_type = 'person' AND person_ref IS NOT NULL AND person_label IS NOT NULL)
    OR (subject_type = 'team' AND external_team_id IS NOT NULL)
  ),
  FOREIGN KEY (org_id, contest_id) REFERENCES contests(org_id, id),
  FOREIGN KEY (org_id, external_team_id) REFERENCES external_teams(org_id, id)
);
CREATE INDEX federation_discipline_member_idx
  ON federation_discipline_records(org_id, member_org_id, status);
CREATE INDEX federation_discipline_contest_idx
  ON federation_discipline_records(org_id, contest_id) WHERE contest_id IS NOT NULL;
SELECT configure_spine_tenant_table('federation_discipline_records');

-- Org-level payer profile so the league can invoice a member club through the
-- normal finance pipeline (billing account is the club official's account).
CREATE TABLE federation_member_payers (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  member_org_id uuid NOT NULL REFERENCES organizations(id),
  billing_account_id uuid NOT NULL REFERENCES accounts(id),
  created_by uuid NOT NULL REFERENCES accounts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, member_org_id)
);
SELECT configure_spine_tenant_table('federation_member_payers');

-- League fee assessments billed to member clubs. invoice_id links to the
-- finance-issued invoice; payment status is derived from invoices at read time.
CREATE TABLE federation_fee_assessments (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  member_org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid,
  team_entry_id uuid,
  description text NOT NULL CHECK (length(trim(description)) > 0),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  due_on date,
  invoice_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'invoiced', 'void')),
  creation_key uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES accounts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, creation_key),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id),
  FOREIGN KEY (org_id, team_entry_id) REFERENCES team_entries(org_id, id),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id)
);
CREATE INDEX federation_fee_assessments_member_idx
  ON federation_fee_assessments(org_id, member_org_id, status);
CREATE INDEX federation_fee_assessments_program_idx
  ON federation_fee_assessments(org_id, program_id) WHERE program_id IS NOT NULL;
SELECT configure_spine_tenant_table('federation_fee_assessments');
