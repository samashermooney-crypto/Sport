ALTER TABLE contests
  ADD COLUMN disputed_at timestamptz,
  ADD COLUMN disputed_by uuid REFERENCES accounts(id),
  ADD COLUMN dispute_reason text;

CREATE TABLE season_survey_campaigns (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid NOT NULL,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed', 'archived')),
  opens_at timestamptz,
  closes_at timestamptz,
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id),
  CHECK (closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at)
);
CREATE INDEX season_survey_campaigns_program_idx
  ON season_survey_campaigns(org_id, program_id, status);
SELECT configure_spine_tenant_table('season_survey_campaigns');

CREATE TABLE season_survey_responses (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  campaign_id uuid NOT NULL,
  respondent_account_id uuid NOT NULL REFERENCES accounts(id),
  nps smallint CHECK (nps IS NULL OR nps BETWEEN 0 AND 10),
  response_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (org_id, id),
  UNIQUE (org_id, campaign_id, respondent_account_id),
  FOREIGN KEY (org_id, campaign_id) REFERENCES season_survey_campaigns(org_id, id)
);
CREATE INDEX season_survey_responses_campaign_idx
  ON season_survey_responses(org_id, campaign_id, created_at DESC);
SELECT configure_spine_tenant_table('season_survey_responses', true);

CREATE TABLE coach_player_ratings (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid NOT NULL,
  team_season_id uuid NOT NULL,
  person_id uuid NOT NULL,
  coach_account_id uuid NOT NULL REFERENCES accounts(id),
  criteria jsonb NOT NULL CHECK (jsonb_typeof(criteria) = 'object'),
  returning_next_season boolean,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (org_id, id),
  UNIQUE (org_id, team_season_id, person_id, coach_account_id),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id)
);
CREATE INDEX coach_player_ratings_program_idx ON coach_player_ratings(org_id, program_id, person_id);
SELECT configure_spine_tenant_table('coach_player_ratings');

CREATE TABLE season_awards (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid NOT NULL,
  person_id uuid,
  team_season_id uuid,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  description text,
  certificate_file_id uuid,
  issued_by uuid NOT NULL REFERENCES accounts(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (org_id, id),
  CHECK (num_nonnulls(person_id, team_season_id) = 1),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id),
  FOREIGN KEY (org_id, certificate_file_id) REFERENCES files(org_id, id)
);
CREATE INDEX season_awards_program_idx ON season_awards(org_id, program_id, issued_at DESC);
SELECT configure_spine_tenant_table('season_awards');
