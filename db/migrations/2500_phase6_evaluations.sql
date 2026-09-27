CREATE TABLE evaluation_events (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  tryout_program_id uuid NOT NULL,
  target_program_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','registration_open','scoring','results','placement','published','completed','archived')),
  normalization text NOT NULL DEFAULT 'z_score_per_evaluator' CHECK (normalization IN ('none','z_score_per_evaluator')),
  share_results_with_families boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  FOREIGN KEY (org_id,tryout_program_id) REFERENCES programs(org_id,id),
  FOREIGN KEY (org_id,target_program_id) REFERENCES programs(org_id,id),
  CHECK (tryout_program_id <> target_program_id)
);
CREATE INDEX evaluation_events_program_idx ON evaluation_events(org_id,target_program_id,status,created_at DESC);
SELECT configure_spine_tenant_table('evaluation_events');

CREATE TABLE evaluation_groups (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  evaluation_event_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  age_min_months integer CHECK (age_min_months IS NULL OR age_min_months >= 0),
  age_max_months integer CHECK (age_max_months IS NULL OR age_max_months >= age_min_months),
  gender text CHECK (gender IN ('female','male','open')),
  position_keys text[] NOT NULL DEFAULT '{}',
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,evaluation_event_id,name),
  FOREIGN KEY (org_id,evaluation_event_id) REFERENCES evaluation_events(org_id,id)
);
CREATE INDEX evaluation_groups_event_idx ON evaluation_groups(org_id,evaluation_event_id,sort_order);
SELECT configure_spine_tenant_table('evaluation_groups');

CREATE TABLE evaluation_criteria (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  evaluation_event_id uuid NOT NULL,
  criterion_key text NOT NULL CHECK (criterion_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  label text NOT NULL CHECK (length(trim(label)) > 0),
  weight numeric(8,4) NOT NULL CHECK (weight > 0),
  scale_min numeric(8,3) NOT NULL,
  scale_max numeric(8,3) NOT NULL,
  position_specific boolean NOT NULL DEFAULT false,
  position_keys text[] NOT NULL DEFAULT '{}',
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,evaluation_event_id,criterion_key),
  FOREIGN KEY (org_id,evaluation_event_id) REFERENCES evaluation_events(org_id,id),
  CHECK (scale_max > scale_min),
  CHECK (NOT position_specific OR cardinality(position_keys) > 0)
);
CREATE INDEX evaluation_criteria_event_idx ON evaluation_criteria(org_id,evaluation_event_id,sort_order);
SELECT configure_spine_tenant_table('evaluation_criteria');

CREATE TABLE evaluation_sessions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  evaluation_event_id uuid NOT NULL,
  evaluation_group_id uuid,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL,
  facility_id uuid,
  capacity integer CHECK (capacity IS NULL OR capacity >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  FOREIGN KEY (org_id,evaluation_event_id) REFERENCES evaluation_events(org_id,id),
  FOREIGN KEY (org_id,evaluation_group_id) REFERENCES evaluation_groups(org_id,id),
  FOREIGN KEY (org_id,facility_id) REFERENCES facilities(org_id,id),
  CHECK (ends_at > starts_at)
);
CREATE INDEX evaluation_sessions_calendar_idx ON evaluation_sessions(org_id,starts_at,ends_at);
SELECT configure_spine_tenant_table('evaluation_sessions');

CREATE TABLE evaluation_participants (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  evaluation_event_id uuid NOT NULL,
  person_id uuid NOT NULL,
  evaluation_group_id uuid NOT NULL,
  evaluation_session_id uuid,
  registration_id uuid,
  bib_number integer NOT NULL CHECK (bib_number > 0),
  media_consent boolean NOT NULL DEFAULT false,
  photo_file_id uuid,
  check_in_status text NOT NULL DEFAULT 'expected' CHECK (check_in_status IN ('expected','checked_in','late','withdrawn')),
  checked_in_at timestamptz,
  checked_in_by uuid REFERENCES accounts(id),
  notes text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,evaluation_event_id,person_id),
  UNIQUE (org_id,evaluation_event_id,evaluation_group_id,bib_number),
  FOREIGN KEY (org_id,evaluation_event_id) REFERENCES evaluation_events(org_id,id),
  FOREIGN KEY (org_id,person_id) REFERENCES people(org_id,id),
  FOREIGN KEY (org_id,evaluation_group_id) REFERENCES evaluation_groups(org_id,id),
  FOREIGN KEY (org_id,evaluation_session_id) REFERENCES evaluation_sessions(org_id,id),
  FOREIGN KEY (org_id,registration_id) REFERENCES registrations(org_id,id),
  FOREIGN KEY (org_id,photo_file_id) REFERENCES files(org_id,id),
  CHECK ((media_consent AND photo_file_id IS NOT NULL) OR (NOT media_consent AND photo_file_id IS NULL)),
  CHECK ((check_in_status IN ('checked_in','late')) = (checked_in_at IS NOT NULL))
);
CREATE INDEX evaluation_participants_group_idx ON evaluation_participants(org_id,evaluation_event_id,evaluation_group_id,bib_number);
CREATE INDEX evaluation_participants_session_idx ON evaluation_participants(org_id,evaluation_session_id,check_in_status);
SELECT configure_spine_tenant_table('evaluation_participants');

CREATE TABLE evaluation_session_evaluators (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  evaluation_session_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  assigned_by uuid NOT NULL REFERENCES accounts(id),
  revoked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,evaluation_session_id,account_id),
  FOREIGN KEY (org_id,evaluation_session_id) REFERENCES evaluation_sessions(org_id,id)
);
CREATE INDEX evaluation_session_evaluators_account_idx ON evaluation_session_evaluators(org_id,account_id,evaluation_session_id) WHERE revoked_at IS NULL;
SELECT configure_spine_tenant_table('evaluation_session_evaluators');

CREATE TABLE evaluation_scores (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  evaluation_event_id uuid NOT NULL,
  evaluation_participant_id uuid NOT NULL,
  evaluation_criterion_id uuid NOT NULL,
  evaluator_account_id uuid NOT NULL REFERENCES accounts(id),
  score numeric(8,3) NOT NULL,
  notes text,
  client_mutation_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  scored_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,evaluation_participant_id,evaluation_criterion_id,evaluator_account_id),
  UNIQUE (org_id,evaluation_event_id,evaluator_account_id,client_mutation_id),
  FOREIGN KEY (org_id,evaluation_event_id) REFERENCES evaluation_events(org_id,id),
  FOREIGN KEY (org_id,evaluation_participant_id) REFERENCES evaluation_participants(org_id,id),
  FOREIGN KEY (org_id,evaluation_criterion_id) REFERENCES evaluation_criteria(org_id,id)
);
CREATE INDEX evaluation_scores_evaluator_idx ON evaluation_scores(org_id,evaluation_event_id,evaluator_account_id,scored_at DESC);
SELECT configure_spine_tenant_table('evaluation_scores');

CREATE TABLE evaluation_results (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  evaluation_event_id uuid NOT NULL,
  evaluation_participant_id uuid NOT NULL,
  normalized_scores jsonb NOT NULL DEFAULT '{}'::jsonb,
  composite numeric(10,4),
  rank_in_group integer CHECK (rank_in_group IS NULL OR rank_in_group > 0),
  evaluator_count integer NOT NULL DEFAULT 0 CHECK (evaluator_count >= 0),
  missing_criteria text[] NOT NULL DEFAULT '{}',
  computed_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,evaluation_participant_id),
  FOREIGN KEY (org_id,evaluation_event_id) REFERENCES evaluation_events(org_id,id),
  FOREIGN KEY (org_id,evaluation_participant_id) REFERENCES evaluation_participants(org_id,id)
);
CREATE INDEX evaluation_results_rank_idx ON evaluation_results(org_id,evaluation_event_id,rank_in_group,composite DESC);
SELECT configure_spine_tenant_table('evaluation_results');

CREATE TABLE placement_boards (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  evaluation_event_id uuid,
  target_program_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  seed integer NOT NULL,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  fairness_metrics jsonb NOT NULL DEFAULT '[]'::jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  FOREIGN KEY (org_id,evaluation_event_id) REFERENCES evaluation_events(org_id,id),
  FOREIGN KEY (org_id,target_program_id) REFERENCES programs(org_id,id)
);
CREATE INDEX placement_boards_program_idx ON placement_boards(org_id,target_program_id,status,updated_at DESC);
SELECT configure_spine_tenant_table('placement_boards');

CREATE TABLE team_placements (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  placement_board_id uuid NOT NULL,
  person_id uuid NOT NULL,
  team_season_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('evaluation','rec_league','manual')),
  seed_rating numeric(10,4),
  locked boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','offer_sent','accepted','declined')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,placement_board_id,person_id),
  FOREIGN KEY (org_id,placement_board_id) REFERENCES placement_boards(org_id,id),
  FOREIGN KEY (org_id,person_id) REFERENCES people(org_id,id),
  FOREIGN KEY (org_id,team_season_id) REFERENCES team_seasons(org_id,id)
);
CREATE INDEX team_placements_team_idx ON team_placements(org_id,placement_board_id,team_season_id,status);
SELECT configure_spine_tenant_table('team_placements');

CREATE TABLE placement_locks (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  placement_board_id uuid NOT NULL,
  person_id uuid NOT NULL,
  team_season_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  locked_by uuid NOT NULL REFERENCES accounts(id),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,placement_board_id,person_id),
  FOREIGN KEY (org_id,placement_board_id) REFERENCES placement_boards(org_id,id),
  FOREIGN KEY (org_id,person_id) REFERENCES people(org_id,id),
  FOREIGN KEY (org_id,team_season_id) REFERENCES team_seasons(org_id,id)
);
SELECT configure_spine_tenant_table('placement_locks');

CREATE TABLE team_offers (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  placement_id uuid NOT NULL,
  person_id uuid NOT NULL,
  household_id uuid NOT NULL,
  offering_id uuid NOT NULL,
  team_season_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  deposit_cents bigint NOT NULL CHECK (deposit_cents >= 0 AND deposit_cents <= amount_cents),
  expires_at timestamptz NOT NULL,
  message text,
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','accepted','declined','expired','withdrawn')),
  decline_reason text,
  responded_at timestamptz,
  registration_id uuid,
  checkout_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  FOREIGN KEY (org_id,placement_id) REFERENCES team_placements(org_id,id),
  FOREIGN KEY (org_id,person_id) REFERENCES people(org_id,id),
  FOREIGN KEY (org_id,household_id) REFERENCES households(org_id,id),
  FOREIGN KEY (org_id,offering_id) REFERENCES registration_offerings(org_id,id),
  FOREIGN KEY (org_id,team_season_id) REFERENCES team_seasons(org_id,id),
  FOREIGN KEY (org_id,registration_id) REFERENCES registrations(org_id,id),
  FOREIGN KEY (org_id,checkout_id) REFERENCES checkouts(org_id,id)
);
CREATE INDEX team_offers_household_idx ON team_offers(org_id,household_id,status,expires_at);
CREATE INDEX team_offers_team_idx ON team_offers(org_id,team_season_id,status,expires_at);
SELECT configure_spine_tenant_table('team_offers');
