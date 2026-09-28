CREATE TABLE placement_preferences (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid NOT NULL,
  person_id uuid NOT NULL,
  friend_request_person_id uuid,
  practice_location text,
  coach_rating numeric(4,2) CHECK (coach_rating IS NULL OR (coach_rating >= 0 AND coach_rating <= 5)),
  note text,
  source text NOT NULL DEFAULT 'staff' CHECK (source IN ('staff','family','import')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,program_id,person_id),
  FOREIGN KEY (org_id,program_id) REFERENCES programs(org_id,id),
  FOREIGN KEY (org_id,person_id) REFERENCES people(org_id,id),
  FOREIGN KEY (org_id,friend_request_person_id) REFERENCES people(org_id,id),
  CHECK (friend_request_person_id IS NULL OR friend_request_person_id <> person_id)
);
CREATE INDEX placement_preferences_program_idx ON placement_preferences(org_id,program_id);
SELECT configure_spine_tenant_table('placement_preferences');
