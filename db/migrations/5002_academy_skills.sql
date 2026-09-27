-- Phase 12 academy / class mode (Track I): athlete skill records and the
-- level promotion workflow (recommendation -> guardian confirmation -> move).

CREATE TABLE athlete_skill_records (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  person_id uuid NOT NULL,
  skill_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'achieved')),
  assessed_by uuid NOT NULL REFERENCES accounts(id),
  assessed_at timestamptz NOT NULL DEFAULT now(),
  note text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, person_id, skill_id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, skill_id) REFERENCES skills(org_id, id)
);
CREATE INDEX athlete_skill_records_person_idx ON athlete_skill_records(org_id, person_id, status);
CREATE INDEX athlete_skill_records_skill_idx ON athlete_skill_records(org_id, skill_id);
SELECT configure_spine_tenant_table('athlete_skill_records');

CREATE TABLE level_promotions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  person_id uuid NOT NULL,
  from_level_id uuid,
  to_level_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'recommended' CHECK (status IN ('recommended', 'approved', 'confirmed', 'completed', 'declined', 'canceled')),
  recommended_by uuid NOT NULL REFERENCES accounts(id),
  recommended_at timestamptz NOT NULL DEFAULT now(),
  note text,
  decided_by_account_id uuid REFERENCES accounts(id),
  decided_at timestamptz,
  source_enrollment_id uuid,
  target_enrollment_id uuid,
  certificate_issued_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (from_level_id IS NULL OR from_level_id <> to_level_id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, from_level_id) REFERENCES skill_levels(org_id, id),
  FOREIGN KEY (org_id, to_level_id) REFERENCES skill_levels(org_id, id),
  FOREIGN KEY (org_id, source_enrollment_id) REFERENCES class_enrollments(org_id, id),
  FOREIGN KEY (org_id, target_enrollment_id) REFERENCES class_enrollments(org_id, id)
);
CREATE INDEX level_promotions_person_idx ON level_promotions(org_id, person_id, status, created_at DESC);
CREATE UNIQUE INDEX level_promotions_open_idx ON level_promotions(org_id, person_id) WHERE status IN ('recommended', 'approved', 'confirmed');
SELECT configure_spine_tenant_table('level_promotions');
