-- One row per (suspension record, finalized contest) so a suspension is served
-- once per game the player's team completes, even when a result is corrected
-- and finalized again.
CREATE TABLE discipline_games_served (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  discipline_record_id uuid NOT NULL,
  contest_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, discipline_record_id, contest_id),
  FOREIGN KEY (org_id, discipline_record_id) REFERENCES discipline_records(org_id, id),
  FOREIGN KEY (org_id, contest_id) REFERENCES contests(org_id, id)
);
CREATE INDEX discipline_games_served_contest_idx
  ON discipline_games_served (org_id, contest_id);
SELECT configure_spine_tenant_table('discipline_games_served', true);
