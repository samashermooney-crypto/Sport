CREATE TABLE programs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  season_id uuid NOT NULL,
  sport_profile_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('league', 'club', 'class', 'camp', 'clinic', 'tryout', 'tournament', 'event', 'membership')),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'registration_open', 'registration_closed', 'in_progress', 'completed', 'archived')),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('public', 'unlisted', 'private')),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  registration_opens_at timestamptz,
  registration_closes_at timestamptz,
  late_registration_closes_at timestamptz,
  eligibility jsonb NOT NULL DEFAULT '{}'::jsonb,
  default_facility_id uuid,
  description_html text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  copied_from_program_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, slug),
  CHECK (starts_on <= ends_on),
  CHECK (registration_opens_at IS NULL OR registration_closes_at IS NULL OR registration_opens_at <= registration_closes_at),
  FOREIGN KEY (org_id, season_id) REFERENCES seasons(org_id, id),
  FOREIGN KEY (org_id, sport_profile_id) REFERENCES sport_profiles(org_id, id),
  FOREIGN KEY (org_id, copied_from_program_id) REFERENCES programs(org_id, id)
);
CREATE INDEX programs_org_season_idx ON programs(org_id, season_id, status);
CREATE INDEX programs_org_status_idx ON programs(org_id, status, starts_on);
CREATE INDEX programs_sport_idx ON programs(org_id, sport_profile_id);
CREATE INDEX programs_copied_idx ON programs(org_id, copied_from_program_id) WHERE copied_from_program_id IS NOT NULL;
SELECT configure_spine_tenant_table('programs');

CREATE TABLE divisions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  code text,
  age_label text,
  eligibility jsonb NOT NULL DEFAULT '{}'::jsonb,
  competition_gender text CHECK (competition_gender IN ('female', 'male', 'open')),
  level text NOT NULL DEFAULT 'open' CHECK (level IN ('recreational', 'developmental', 'competitive', 'elite', 'open')),
  capacity_players integer CHECK (capacity_players IS NULL OR capacity_players >= 0),
  capacity_teams integer CHECK (capacity_teams IS NULL OR capacity_teams >= 0),
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, program_id, name),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id)
);
CREATE INDEX divisions_program_order_idx ON divisions(org_id, program_id, sort_order);
SELECT configure_spine_tenant_table('divisions');

CREATE TABLE registration_offerings (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid NOT NULL,
  division_id uuid,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  registrant_role text NOT NULL CHECK (registrant_role IN ('athlete', 'coach', 'volunteer', 'team_entry', 'official')),
  price_cents bigint NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  pricing jsonb NOT NULL DEFAULT '{}'::jsonb,
  capacity integer CHECK (capacity IS NULL OR capacity >= 0),
  waitlist_enabled boolean NOT NULL DEFAULT false,
  requires_approval boolean NOT NULL DEFAULT false,
  form_definition_ids uuid[] NOT NULL DEFAULT '{}',
  waiver_document_ids uuid[] NOT NULL DEFAULT '{}',
  add_ons jsonb NOT NULL DEFAULT '[]'::jsonb,
  visibility text NOT NULL DEFAULT 'staff_only' CHECK (visibility IN ('public', 'invite_only', 'staff_only')),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id),
  FOREIGN KEY (org_id, division_id) REFERENCES divisions(org_id, id)
);
CREATE INDEX registration_offerings_program_idx ON registration_offerings(org_id, program_id, active, sort_order);
CREATE INDEX registration_offerings_division_idx ON registration_offerings(org_id, division_id) WHERE division_id IS NOT NULL;
SELECT configure_spine_tenant_table('registration_offerings');

CREATE TABLE capacity_counters (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  subject_type text NOT NULL CHECK (subject_type IN ('offering', 'division', 'program', 'class_session', 'evaluation_session', 'volunteer_shift')),
  subject_id uuid NOT NULL,
  capacity integer CHECK (capacity IS NULL OR capacity >= 0),
  confirmed integer NOT NULL DEFAULT 0 CHECK (confirmed >= 0),
  held integer NOT NULL DEFAULT 0 CHECK (held >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, subject_type, subject_id),
  CHECK (capacity IS NULL OR confirmed + held <= capacity)
);
CREATE INDEX capacity_counters_subject_idx ON capacity_counters(org_id, subject_type, subject_id);
SELECT configure_spine_tenant_table('capacity_counters');

CREATE TABLE teams (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  short_name text,
  sport_profile_id uuid NOT NULL,
  competition_gender text CHECK (competition_gender IN ('female', 'male', 'open')),
  birth_year integer CHECK (birth_year IS NULL OR birth_year BETWEEN 1900 AND 2200),
  age_label text,
  level text NOT NULL DEFAULT 'open' CHECK (level IN ('recreational', 'developmental', 'competitive', 'elite', 'open')),
  colors jsonb NOT NULL DEFAULT '{}'::jsonb,
  logo_file_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  external_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, sport_profile_id) REFERENCES sport_profiles(org_id, id)
);
CREATE INDEX teams_org_name_idx ON teams(org_id, name) WHERE status = 'active';
CREATE INDEX teams_sport_idx ON teams(org_id, sport_profile_id);
SELECT configure_spine_tenant_table('teams');

CREATE TABLE team_seasons (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  team_id uuid NOT NULL,
  program_id uuid NOT NULL,
  division_id uuid NOT NULL,
  display_name text,
  roster_limit integer CHECK (roster_limit IS NULL OR roster_limit >= 0),
  roster_locked_at timestamptz,
  status text NOT NULL DEFAULT 'forming' CHECK (status IN ('forming', 'active', 'completed', 'withdrawn')),
  home_facility_id uuid,
  practice_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, team_id, program_id),
  FOREIGN KEY (org_id, team_id) REFERENCES teams(org_id, id),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id),
  FOREIGN KEY (org_id, division_id) REFERENCES divisions(org_id, id)
);
CREATE INDEX team_seasons_program_idx ON team_seasons(org_id, program_id, division_id, status);
CREATE INDEX team_seasons_team_idx ON team_seasons(org_id, team_id);
SELECT configure_spine_tenant_table('team_seasons');

CREATE TABLE roster_entries (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  team_season_id uuid NOT NULL,
  person_id uuid NOT NULL,
  registration_id uuid,
  kind text NOT NULL DEFAULT 'rostered' CHECK (kind IN ('rostered', 'guest', 'practice_only')),
  jersey_number text,
  positions text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'injured', 'suspended', 'inactive', 'released')),
  joined_on date NOT NULL DEFAULT CURRENT_DATE,
  left_on date,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  CHECK (left_on IS NULL OR left_on >= joined_on)
);
CREATE UNIQUE INDEX roster_entries_active_person_idx ON roster_entries(org_id, team_season_id, person_id) WHERE status IN ('active', 'injured', 'suspended');
CREATE UNIQUE INDEX roster_entries_active_jersey_idx ON roster_entries(org_id, team_season_id, jersey_number) WHERE jersey_number IS NOT NULL AND status IN ('active', 'injured', 'suspended');
CREATE INDEX roster_entries_person_idx ON roster_entries(org_id, person_id, status);
CREATE INDEX roster_entries_registration_idx ON roster_entries(org_id, registration_id) WHERE registration_id IS NOT NULL;
SELECT configure_spine_tenant_table('roster_entries');

CREATE TABLE team_staff (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  team_season_id uuid NOT NULL,
  person_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('head_coach', 'assistant_coach', 'team_manager', 'trainer', 'treasurer', 'other')),
  status text NOT NULL DEFAULT 'pending_compliance' CHECK (status IN ('pending_compliance', 'active', 'removed')),
  added_by uuid NOT NULL REFERENCES accounts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id)
);
CREATE UNIQUE INDEX team_staff_active_role_idx ON team_staff(org_id, team_season_id, person_id, role) WHERE status <> 'removed';
CREATE INDEX team_staff_person_idx ON team_staff(org_id, person_id, status);
SELECT configure_spine_tenant_table('team_staff');

CREATE TABLE external_teams (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  club_name text,
  contact_name text,
  contact_email citext,
  contact_phone text,
  sport_profile_id uuid NOT NULL,
  age_label text,
  competition_gender text CHECK (competition_gender IN ('female', 'male', 'open')),
  linked_org_id uuid REFERENCES organizations(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, sport_profile_id) REFERENCES sport_profiles(org_id, id)
);
CREATE INDEX external_teams_sport_idx ON external_teams(org_id, sport_profile_id);
CREATE INDEX external_teams_linked_idx ON external_teams(linked_org_id) WHERE linked_org_id IS NOT NULL;
SELECT configure_spine_tenant_table('external_teams');
