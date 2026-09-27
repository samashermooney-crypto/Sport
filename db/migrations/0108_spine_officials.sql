CREATE TABLE official_profiles (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  person_id uuid NOT NULL,
  grade text,
  level text,
  sports uuid[] NOT NULL DEFAULT '{}',
  max_games_per_day integer CHECK (max_games_per_day IS NULL OR max_games_per_day > 0),
  home_area text,
  travel_radius_km integer CHECK (travel_radius_km IS NULL OR travel_radius_km >= 0),
  pay_rates jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, person_id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id)
);
CREATE INDEX official_profiles_active_idx ON official_profiles(org_id, active, level);
SELECT configure_spine_tenant_table('official_profiles');

CREATE TABLE official_availability (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  person_id uuid NOT NULL,
  rrule text,
  starts_on date,
  ends_on date,
  available boolean NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (rrule IS NOT NULL OR (starts_on IS NOT NULL AND ends_on IS NOT NULL)),
  CHECK (starts_on IS NULL OR ends_on IS NULL OR starts_on <= ends_on),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id)
);
CREATE INDEX official_availability_person_idx ON official_availability(org_id, person_id, starts_on, ends_on);
SELECT configure_spine_tenant_table('official_availability');

CREATE TABLE official_positions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  sport_profile_id uuid NOT NULL,
  key text NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, sport_profile_id, key),
  FOREIGN KEY (org_id, sport_profile_id) REFERENCES sport_profiles(org_id, id)
);
CREATE INDEX official_positions_sport_idx ON official_positions(org_id, sport_profile_id, sort_order);
SELECT configure_spine_tenant_table('official_positions');

CREATE TABLE official_assignments (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  contest_id uuid NOT NULL,
  position_key text NOT NULL,
  person_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'accepted', 'declined', 'confirmed', 'canceled', 'no_show')),
  fee_cents bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  mileage_cents bigint NOT NULL DEFAULT 0 CHECK (mileage_cents >= 0),
  assigned_by uuid NOT NULL REFERENCES accounts(id),
  responded_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, contest_id) REFERENCES contests(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id)
);
CREATE UNIQUE INDEX official_assignments_active_position_idx ON official_assignments(org_id, contest_id, position_key) WHERE status <> 'canceled';
CREATE INDEX official_assignments_person_idx ON official_assignments(org_id, person_id, status, created_at DESC);
SELECT configure_spine_tenant_table('official_assignments');

CREATE TABLE official_pay_batches (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'paid')),
  paid_via text CHECK (paid_via IN ('external', 'check', 'other')),
  paid_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (period_start <= period_end),
  CHECK (status <> 'paid' OR (paid_via IS NOT NULL AND paid_at IS NOT NULL))
);
CREATE INDEX official_pay_batches_period_idx ON official_pay_batches(org_id, period_start, period_end, status);
SELECT configure_spine_tenant_table('official_pay_batches');

CREATE TABLE official_pay_lines (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  batch_id uuid NOT NULL,
  person_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  fee_cents bigint NOT NULL CHECK (fee_cents >= 0),
  mileage_cents bigint NOT NULL DEFAULT 0 CHECK (mileage_cents >= 0),
  total_cents bigint GENERATED ALWAYS AS (fee_cents + mileage_cents) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, assignment_id),
  FOREIGN KEY (org_id, batch_id) REFERENCES official_pay_batches(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, assignment_id) REFERENCES official_assignments(org_id, id)
);
CREATE INDEX official_pay_lines_batch_idx ON official_pay_lines(org_id, batch_id);
CREATE INDEX official_pay_lines_person_idx ON official_pay_lines(org_id, person_id, created_at DESC);
SELECT configure_spine_tenant_table('official_pay_lines');
