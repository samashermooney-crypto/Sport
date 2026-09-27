CREATE TABLE tournament_schedule_reservations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  bracket_id uuid NOT NULL,
  bracket_match_id uuid,
  event_id uuid NOT NULL,
  slot_type text NOT NULL CHECK (slot_type IN ('pool', 'bracket')),
  round_index integer NOT NULL CHECK (round_index > 0),
  position integer NOT NULL CHECK (position > 0),
  home_placeholder text,
  away_placeholder text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (org_id, id),
  UNIQUE (org_id, event_id),
  UNIQUE (org_id, bracket_id, slot_type, round_index, position),
  FOREIGN KEY (org_id, bracket_id) REFERENCES brackets(org_id, id),
  FOREIGN KEY (org_id, bracket_match_id) REFERENCES bracket_matches(org_id, id),
  FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id)
);
CREATE UNIQUE INDEX tournament_schedule_reservations_match_idx
  ON tournament_schedule_reservations(org_id, bracket_match_id)
  WHERE bracket_match_id IS NOT NULL;
CREATE INDEX tournament_schedule_reservations_bracket_order_idx
  ON tournament_schedule_reservations(org_id, bracket_id, slot_type, round_index, position);
SELECT configure_spine_tenant_table('tournament_schedule_reservations');
