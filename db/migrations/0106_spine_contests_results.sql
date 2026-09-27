CREATE TABLE contests (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  event_id uuid NOT NULL,
  sport_profile_id uuid NOT NULL,
  profile_version integer NOT NULL CHECK (profile_version >= 1),
  format text NOT NULL CHECK (format IN ('head_to_head_score', 'head_to_head_sets', 'head_to_head_bout', 'multi_timed', 'multi_measured', 'judged', 'placement_only')),
  stage text NOT NULL DEFAULT 'regular' CHECK (stage IN ('regular', 'pool', 'playoff', 'championship', 'consolation', 'friendly', 'exhibition')),
  counts_for_standings boolean NOT NULL DEFAULT true,
  bracket_match_id uuid,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'final', 'forfeit', 'canceled', 'abandoned')),
  result_entered_by uuid REFERENCES accounts(id),
  result_confirmed_by uuid REFERENCES accounts(id),
  finalized_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, event_id),
  FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id),
  FOREIGN KEY (org_id, sport_profile_id) REFERENCES sport_profiles(org_id, id)
);
CREATE INDEX contests_status_idx ON contests(org_id, status, created_at DESC);
CREATE INDEX contests_sport_idx ON contests(org_id, sport_profile_id);
CREATE INDEX contests_bracket_idx ON contests(org_id, bracket_match_id) WHERE bracket_match_id IS NOT NULL;
SELECT configure_spine_tenant_table('contests');

CREATE TABLE contest_participants (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  contest_id uuid NOT NULL,
  team_season_id uuid,
  external_team_id uuid,
  person_id uuid,
  side text NOT NULL DEFAULT 'none' CHECK (side IN ('home', 'away', 'none')),
  lane integer CHECK (lane IS NULL OR lane > 0),
  heat integer CHECK (heat IS NULL OR heat > 0),
  flight integer CHECK (flight IS NULL OR flight > 0),
  seed integer CHECK (seed IS NULL OR seed > 0),
  entry_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (num_nonnulls(team_season_id, external_team_id, person_id) = 1),
  FOREIGN KEY (org_id, contest_id) REFERENCES contests(org_id, id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id),
  FOREIGN KEY (org_id, external_team_id) REFERENCES external_teams(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id)
);
CREATE INDEX contest_participants_contest_idx ON contest_participants(org_id, contest_id, side);
CREATE INDEX contest_participants_team_idx ON contest_participants(org_id, team_season_id) WHERE team_season_id IS NOT NULL;
CREATE INDEX contest_participants_person_idx ON contest_participants(org_id, person_id) WHERE person_id IS NOT NULL;
CREATE INDEX contest_participants_external_idx ON contest_participants(org_id, external_team_id) WHERE external_team_id IS NOT NULL;
SELECT configure_spine_tenant_table('contest_participants');

CREATE TABLE contest_results (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  contest_participant_id uuid NOT NULL,
  outcome text NOT NULL DEFAULT 'none' CHECK (outcome IN ('win', 'loss', 'tie', 'none')),
  place integer CHECK (place IS NULL OR place > 0),
  score numeric,
  score_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'dnf', 'dns', 'dq', 'forfeit_win', 'forfeit_loss', 'no_contest')),
  points_awarded numeric,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, contest_participant_id),
  FOREIGN KEY (org_id, contest_participant_id) REFERENCES contest_participants(org_id, id)
);
SELECT configure_spine_tenant_table('contest_results');

CREATE TABLE stat_lines (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  contest_id uuid NOT NULL,
  person_id uuid,
  team_season_id uuid,
  stat_key text NOT NULL,
  value numeric NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE NULLS NOT DISTINCT (org_id, contest_id, person_id, team_season_id, stat_key),
  CHECK ((person_id IS NOT NULL) <> (team_season_id IS NOT NULL)),
  FOREIGN KEY (org_id, contest_id) REFERENCES contests(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id)
);
CREATE INDEX stat_lines_person_idx ON stat_lines(org_id, person_id, stat_key) WHERE person_id IS NOT NULL;
CREATE INDEX stat_lines_team_idx ON stat_lines(org_id, team_season_id, stat_key) WHERE team_season_id IS NOT NULL;
SELECT configure_spine_tenant_table('stat_lines');

CREATE TABLE result_audit (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  contest_id uuid NOT NULL,
  actor_account_id uuid NOT NULL REFERENCES accounts(id),
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, contest_id) REFERENCES contests(org_id, id)
);
CREATE INDEX result_audit_contest_idx ON result_audit(org_id, contest_id, created_at DESC);
SELECT configure_spine_tenant_table('result_audit', true);

CREATE TABLE standings_configs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid,
  division_id uuid,
  config jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (num_nonnulls(program_id, division_id) = 1),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id),
  FOREIGN KEY (org_id, division_id) REFERENCES divisions(org_id, id)
);
CREATE UNIQUE INDEX standings_configs_program_idx ON standings_configs(org_id, program_id) WHERE program_id IS NOT NULL;
CREATE UNIQUE INDEX standings_configs_division_idx ON standings_configs(org_id, division_id) WHERE division_id IS NOT NULL;
SELECT configure_spine_tenant_table('standings_configs');

CREATE TABLE standings_snapshots (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  scope_type text NOT NULL CHECK (scope_type IN ('program', 'division')),
  scope_id uuid NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX standings_snapshots_scope_idx ON standings_snapshots(org_id, scope_type, scope_id, computed_at DESC);
SELECT configure_spine_tenant_table('standings_snapshots');

CREATE TABLE brackets (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid NOT NULL,
  division_id uuid,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  type text NOT NULL CHECK (type IN ('single_elim', 'double_elim', 'round_robin_pools', 'pools_to_bracket', 'consolation', 'ladder')),
  size integer NOT NULL CHECK (size > 0),
  seeding_source text NOT NULL CHECK (seeding_source IN ('manual', 'standings', 'pool_results', 'random')),
  third_place boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'in_progress', 'completed')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id),
  FOREIGN KEY (org_id, division_id) REFERENCES divisions(org_id, id)
);
CREATE INDEX brackets_program_idx ON brackets(org_id, program_id, status);
CREATE INDEX brackets_division_idx ON brackets(org_id, division_id) WHERE division_id IS NOT NULL;
SELECT configure_spine_tenant_table('brackets');

CREATE TABLE bracket_matches (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  bracket_id uuid NOT NULL,
  round integer NOT NULL CHECK (round >= 0),
  position integer NOT NULL CHECK (position > 0),
  winner_to_match_id uuid,
  winner_to_slot text CHECK (winner_to_slot IN ('a', 'b')),
  loser_to_match_id uuid,
  loser_to_slot text CHECK (loser_to_slot IN ('a', 'b')),
  participant_a jsonb,
  participant_b jsonb,
  contest_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, bracket_id, round, position),
  CHECK ((winner_to_match_id IS NULL) = (winner_to_slot IS NULL)),
  CHECK ((loser_to_match_id IS NULL) = (loser_to_slot IS NULL)),
  FOREIGN KEY (org_id, bracket_id) REFERENCES brackets(org_id, id),
  FOREIGN KEY (org_id, winner_to_match_id) REFERENCES bracket_matches(org_id, id),
  FOREIGN KEY (org_id, loser_to_match_id) REFERENCES bracket_matches(org_id, id),
  FOREIGN KEY (org_id, contest_id) REFERENCES contests(org_id, id)
);
CREATE INDEX bracket_matches_winner_idx ON bracket_matches(org_id, winner_to_match_id) WHERE winner_to_match_id IS NOT NULL;
CREATE INDEX bracket_matches_loser_idx ON bracket_matches(org_id, loser_to_match_id) WHERE loser_to_match_id IS NOT NULL;
CREATE INDEX bracket_matches_contest_idx ON bracket_matches(org_id, contest_id) WHERE contest_id IS NOT NULL;
SELECT configure_spine_tenant_table('bracket_matches');
ALTER TABLE contests ADD CONSTRAINT contests_bracket_match_fk FOREIGN KEY (org_id, bracket_match_id) REFERENCES bracket_matches(org_id, id);

CREATE TABLE pools (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  bracket_id uuid NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, bracket_id, name),
  FOREIGN KEY (org_id, bracket_id) REFERENCES brackets(org_id, id)
);
CREATE INDEX pools_bracket_idx ON pools(org_id, bracket_id, sort_order);
SELECT configure_spine_tenant_table('pools');

CREATE TABLE pool_members (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  pool_id uuid NOT NULL,
  team_season_id uuid,
  external_team_id uuid,
  person_id uuid,
  seed integer CHECK (seed IS NULL OR seed > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (num_nonnulls(team_season_id, external_team_id, person_id) = 1),
  FOREIGN KEY (org_id, pool_id) REFERENCES pools(org_id, id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id),
  FOREIGN KEY (org_id, external_team_id) REFERENCES external_teams(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id)
);
CREATE INDEX pool_members_pool_idx ON pool_members(org_id, pool_id);
CREATE INDEX pool_members_team_idx ON pool_members(org_id, team_season_id) WHERE team_season_id IS NOT NULL;
CREATE INDEX pool_members_person_idx ON pool_members(org_id, person_id) WHERE person_id IS NOT NULL;
SELECT configure_spine_tenant_table('pool_members');

CREATE TABLE lineups (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  contest_id uuid NOT NULL,
  team_season_id uuid NOT NULL,
  entries jsonb NOT NULL DEFAULT '[]'::jsonb,
  submitted_by uuid REFERENCES accounts(id),
  locked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, contest_id, team_season_id),
  FOREIGN KEY (org_id, contest_id) REFERENCES contests(org_id, id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id)
);
CREATE INDEX lineups_team_idx ON lineups(org_id, team_season_id);
SELECT configure_spine_tenant_table('lineups');

CREATE TABLE playing_time (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  contest_id uuid NOT NULL,
  person_id uuid NOT NULL,
  periods_played integer[],
  minutes numeric CHECK (minutes IS NULL OR minutes >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, contest_id, person_id),
  CHECK (periods_played IS NOT NULL OR minutes IS NOT NULL),
  FOREIGN KEY (org_id, contest_id) REFERENCES contests(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id)
);
CREATE INDEX playing_time_person_idx ON playing_time(org_id, person_id);
SELECT configure_spine_tenant_table('playing_time');

CREATE TABLE game_reports (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  contest_id uuid NOT NULL,
  submitted_by uuid NOT NULL REFERENCES accounts(id),
  role text NOT NULL CHECK (role IN ('official', 'coach', 'site_director')),
  body_html text NOT NULL,
  incidents jsonb NOT NULL DEFAULT '[]'::jsonb,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, contest_id) REFERENCES contests(org_id, id)
);
CREATE INDEX game_reports_contest_idx ON game_reports(org_id, contest_id, submitted_at DESC);
SELECT configure_spine_tenant_table('game_reports', true);

CREATE TABLE discipline_records (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  person_id uuid,
  team_season_id uuid,
  contest_id uuid,
  type text NOT NULL CHECK (type IN ('caution', 'send_off', 'ejection', 'technical', 'suspension', 'fine', 'other')),
  description text NOT NULL,
  suspension_games integer CHECK (suspension_games IS NULL OR suspension_games >= 0),
  suspension_until date,
  games_served integer NOT NULL DEFAULT 0 CHECK (games_served >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'served', 'appealed', 'overturned')),
  issued_by uuid NOT NULL REFERENCES accounts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (num_nonnulls(person_id, team_season_id) >= 1),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id),
  FOREIGN KEY (org_id, contest_id) REFERENCES contests(org_id, id)
);
CREATE INDEX discipline_records_person_idx ON discipline_records(org_id, person_id, status) WHERE person_id IS NOT NULL;
CREATE INDEX discipline_records_team_idx ON discipline_records(org_id, team_season_id, status) WHERE team_season_id IS NOT NULL;
CREATE INDEX discipline_records_contest_idx ON discipline_records(org_id, contest_id) WHERE contest_id IS NOT NULL;
SELECT configure_spine_tenant_table('discipline_records');
