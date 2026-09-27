CREATE TABLE tournament_entries (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  bracket_id uuid NOT NULL,
  team_season_id uuid,
  external_team_id uuid,
  status text NOT NULL DEFAULT 'entered' CHECK (status IN ('entered', 'checked_in', 'withdrawn')),
  seed integer CHECK (seed IS NULL OR seed > 0),
  checked_in_at timestamptz,
  checked_in_by uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (org_id, id),
  CHECK (num_nonnulls(team_season_id, external_team_id) = 1),
  CHECK ((status = 'checked_in') = (checked_in_at IS NOT NULL AND checked_in_by IS NOT NULL)),
  FOREIGN KEY (org_id, bracket_id) REFERENCES brackets(org_id, id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id),
  FOREIGN KEY (org_id, external_team_id) REFERENCES external_teams(org_id, id)
);
CREATE UNIQUE INDEX tournament_entries_team_idx
  ON tournament_entries(org_id, bracket_id, team_season_id)
  WHERE team_season_id IS NOT NULL AND status <> 'withdrawn';
CREATE UNIQUE INDEX tournament_entries_external_team_idx
  ON tournament_entries(org_id, bracket_id, external_team_id)
  WHERE external_team_id IS NOT NULL AND status <> 'withdrawn';
CREATE INDEX tournament_entries_status_idx
  ON tournament_entries(org_id, bracket_id, status, seed);
SELECT configure_spine_tenant_table('tournament_entries');
