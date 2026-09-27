CREATE TABLE schedule_blackout_requests (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  team_season_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES accounts(id),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'withdrawn')),
  decided_by uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (org_id, id),
  CHECK (starts_on <= ends_on),
  CHECK ((status = 'pending' AND decided_by IS NULL) OR status <> 'pending'),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id)
);
CREATE INDEX schedule_blackout_requests_team_idx
  ON schedule_blackout_requests(org_id, team_season_id, status, starts_on);
SELECT configure_spine_tenant_table('schedule_blackout_requests');
