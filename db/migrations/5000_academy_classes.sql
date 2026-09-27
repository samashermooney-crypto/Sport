-- Phase 12 academy / class mode (Track I): skill levels, class offerings,
-- schedules, instructors, sessions, enrollments and waitlists.

CREATE TABLE skill_levels (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  sport_profile_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  description text,
  sort_order integer NOT NULL CHECK (sort_order > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, sport_profile_id, sort_order),
  FOREIGN KEY (org_id, sport_profile_id) REFERENCES sport_profiles(org_id, id)
);
CREATE INDEX skill_levels_profile_idx ON skill_levels(org_id, sport_profile_id, sort_order);
SELECT configure_spine_tenant_table('skill_levels');

CREATE TABLE skills (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  skill_level_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  description text,
  video_url text,
  sort_order integer NOT NULL DEFAULT 1 CHECK (sort_order > 0),
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, skill_level_id) REFERENCES skill_levels(org_id, id)
);
CREATE INDEX skills_level_idx ON skills(org_id, skill_level_id, sort_order) WHERE archived_at IS NULL;
SELECT configure_spine_tenant_table('skills');

CREATE TABLE class_offerings (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid NOT NULL,
  skill_level_id uuid,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  description text,
  age_min_months integer CHECK (age_min_months IS NULL OR age_min_months >= 0),
  age_max_months integer CHECK (age_max_months IS NULL OR age_max_months >= 0),
  capacity integer NOT NULL CHECK (capacity > 0),
  instructor_ratio numeric(6, 2) NOT NULL CHECK (instructor_ratio > 0),
  billing text NOT NULL CHECK (billing IN ('term', 'monthly', 'drop_in', 'punch_card')),
  price_cents bigint NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  punch_card_uses integer CHECK (punch_card_uses IS NULL OR punch_card_uses > 0),
  tuition_tiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  annual_fee_cents bigint NOT NULL DEFAULT 0 CHECK (annual_fee_cents >= 0),
  annual_fee_interval_months integer NOT NULL DEFAULT 12 CHECK (annual_fee_interval_months > 0),
  trial_allowed boolean NOT NULL DEFAULT false,
  trial_price_cents bigint NOT NULL DEFAULT 0 CHECK (trial_price_cents >= 0),
  makeup_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  sibling_discount_bps integer[] NOT NULL DEFAULT '{}',
  gl_code text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (age_min_months IS NULL OR age_max_months IS NULL OR age_min_months <= age_max_months),
  CHECK (billing <> 'punch_card' OR punch_card_uses IS NOT NULL),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id),
  FOREIGN KEY (org_id, skill_level_id) REFERENCES skill_levels(org_id, id)
);
CREATE INDEX class_offerings_program_idx ON class_offerings(org_id, program_id, status);
CREATE INDEX class_offerings_level_idx ON class_offerings(org_id, skill_level_id) WHERE skill_level_id IS NOT NULL;
SELECT configure_spine_tenant_table('class_offerings');

CREATE TABLE class_schedules (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  class_offering_id uuid NOT NULL,
  recurrence jsonb NOT NULL,
  start_time time NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  timezone text NOT NULL,
  space_id uuid,
  location_text text,
  term_start date NOT NULL,
  term_end date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'canceled')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (term_start <= term_end),
  FOREIGN KEY (org_id, class_offering_id) REFERENCES class_offerings(org_id, id),
  FOREIGN KEY (org_id, space_id) REFERENCES spaces(org_id, id)
);
CREATE INDEX class_schedules_offering_idx ON class_schedules(org_id, class_offering_id, status);
CREATE INDEX class_schedules_space_idx ON class_schedules(org_id, space_id) WHERE space_id IS NOT NULL;
SELECT configure_spine_tenant_table('class_schedules');

CREATE TABLE class_instructors (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  class_schedule_id uuid NOT NULL,
  person_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending_compliance' CHECK (status IN ('pending_compliance', 'active', 'removed')),
  added_by uuid NOT NULL REFERENCES accounts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, class_schedule_id) REFERENCES class_schedules(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id)
);
CREATE UNIQUE INDEX class_instructors_live_idx ON class_instructors(org_id, class_schedule_id, person_id) WHERE status <> 'removed';
CREATE INDEX class_instructors_person_idx ON class_instructors(org_id, person_id) WHERE status <> 'removed';
SELECT configure_spine_tenant_table('class_instructors');

CREATE TABLE class_sessions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  event_id uuid NOT NULL,
  class_offering_id uuid NOT NULL,
  class_schedule_id uuid NOT NULL,
  capacity integer CHECK (capacity IS NULL OR capacity > 0),
  substitute_person_id uuid,
  holiday_skipped boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, event_id),
  FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id),
  FOREIGN KEY (org_id, class_offering_id) REFERENCES class_offerings(org_id, id),
  FOREIGN KEY (org_id, class_schedule_id) REFERENCES class_schedules(org_id, id),
  FOREIGN KEY (org_id, substitute_person_id) REFERENCES people(org_id, id)
);
CREATE INDEX class_sessions_offering_idx ON class_sessions(org_id, class_offering_id);
CREATE INDEX class_sessions_schedule_idx ON class_sessions(org_id, class_schedule_id);
SELECT configure_spine_tenant_table('class_sessions');
