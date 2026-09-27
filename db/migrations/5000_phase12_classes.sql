CREATE TABLE class_offerings (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  level text NOT NULL CHECK (length(trim(level)) > 0),
  minimum_age_months integer NOT NULL CHECK (minimum_age_months >= 0),
  maximum_age_months integer NOT NULL CHECK (maximum_age_months >= minimum_age_months),
  capacity integer NOT NULL CHECK (capacity > 0),
  instructor_ratio integer NOT NULL CHECK (instructor_ratio > 0),
  billing_term text NOT NULL CHECK (billing_term IN ('monthly','drop_in','punch_card')),
  tuition_tiers jsonb NOT NULL DEFAULT '[]'::jsonb,
  trial_allowed boolean NOT NULL DEFAULT false,
  makeup_credits_per_term integer NOT NULL DEFAULT 0 CHECK (makeup_credits_per_term >= 0),
  makeup_expires_after_days integer NOT NULL DEFAULT 90 CHECK (makeup_expires_after_days BETWEEN 1 AND 730),
  makeup_eligible boolean NOT NULL DEFAULT true,
  recurrence jsonb,
  active boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,program_id,name,level),
  FOREIGN KEY (org_id,program_id) REFERENCES programs(org_id,id)
);
CREATE INDEX class_offerings_browse_idx ON class_offerings(org_id,active,level,minimum_age_months,maximum_age_months);
SELECT configure_spine_tenant_table('class_offerings');

CREATE TABLE class_sessions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  class_offering_id uuid NOT NULL,
  event_id uuid,
  local_date date NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL,
  facility_id uuid,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','canceled','completed')),
  cancellation_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,class_offering_id,starts_at),
  FOREIGN KEY (org_id,class_offering_id) REFERENCES class_offerings(org_id,id),
  FOREIGN KEY (org_id,event_id) REFERENCES events(org_id,id),
  FOREIGN KEY (org_id,facility_id) REFERENCES facilities(org_id,id),
  CHECK (ends_at > starts_at)
);
CREATE INDEX class_sessions_calendar_idx ON class_sessions(org_id,starts_at,ends_at,status);
CREATE INDEX class_sessions_offering_idx ON class_sessions(org_id,class_offering_id,local_date,status);
SELECT configure_spine_tenant_table('class_sessions');

CREATE TABLE class_instructors (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  class_offering_id uuid NOT NULL,
  person_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'instructor' CHECK (role IN ('lead','instructor','substitute')),
  starts_on date NOT NULL,
  ends_on date,
  status text NOT NULL DEFAULT 'pending_compliance' CHECK (status IN ('pending_compliance','active','removed')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  FOREIGN KEY (org_id,class_offering_id) REFERENCES class_offerings(org_id,id),
  FOREIGN KEY (org_id,person_id) REFERENCES people(org_id,id),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX class_instructors_active_idx ON class_instructors(org_id,class_offering_id,starts_on,ends_on) WHERE status = 'active';
SELECT configure_spine_tenant_table('class_instructors');

CREATE TABLE class_enrollments (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  class_offering_id uuid NOT NULL,
  person_id uuid NOT NULL,
  household_id uuid NOT NULL,
  registration_id uuid,
  status text NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled','trial','waitlisted','paused','withdrawal_pending','withdrawn','completed')),
  billing_tier text NOT NULL DEFAULT 'standard',
  enrolled_on date NOT NULL DEFAULT CURRENT_DATE,
  withdrawn_on date,
  withdrawal_notice_on date,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  FOREIGN KEY (org_id,class_offering_id) REFERENCES class_offerings(org_id,id),
  FOREIGN KEY (org_id,person_id) REFERENCES people(org_id,id),
  FOREIGN KEY (org_id,household_id) REFERENCES households(org_id,id),
  FOREIGN KEY (org_id,registration_id) REFERENCES registrations(org_id,id),
  CHECK (withdrawn_on IS NULL OR withdrawn_on >= enrolled_on)
);
CREATE UNIQUE INDEX class_enrollments_live_person_idx ON class_enrollments(org_id,class_offering_id,person_id) WHERE status IN ('enrolled','trial','paused','withdrawal_pending');
CREATE INDEX class_enrollments_household_idx ON class_enrollments(org_id,household_id,status);
CREATE INDEX class_enrollments_capacity_idx ON class_enrollments(org_id,class_offering_id,status) WHERE status IN ('enrolled','trial','withdrawal_pending');
SELECT configure_spine_tenant_table('class_enrollments');

CREATE TABLE class_tuition_subscriptions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  class_enrollment_id uuid NOT NULL,
  billing_day smallint NOT NULL CHECK (billing_day BETWEEN 1 AND 28),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','past_due','canceled')),
  paused_until date,
  next_invoice_on date NOT NULL,
  last_invoice_id uuid,
  last_billing_key text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,class_enrollment_id),
  FOREIGN KEY (org_id,class_enrollment_id) REFERENCES class_enrollments(org_id,id),
  FOREIGN KEY (org_id,last_invoice_id) REFERENCES invoices(org_id,id)
);
CREATE INDEX class_tuition_due_idx ON class_tuition_subscriptions(org_id,next_invoice_on,status) WHERE status IN ('active','past_due');
SELECT configure_spine_tenant_table('class_tuition_subscriptions');

CREATE TABLE class_attendance (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  class_session_id uuid NOT NULL,
  class_enrollment_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'present' CHECK (status IN ('present','absent','late','excused')),
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  pickup_account_id uuid REFERENCES accounts(id),
  recorded_by uuid REFERENCES accounts(id),
  makeup_credit_issued boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,class_session_id,class_enrollment_id),
  FOREIGN KEY (org_id,class_session_id) REFERENCES class_sessions(org_id,id),
  FOREIGN KEY (org_id,class_enrollment_id) REFERENCES class_enrollments(org_id,id),
  CHECK (checked_out_at IS NULL OR checked_in_at IS NOT NULL),
  CHECK (checked_out_at IS NULL OR checked_out_at >= checked_in_at)
);
CREATE INDEX class_attendance_session_idx ON class_attendance(org_id,class_session_id,status);
SELECT configure_spine_tenant_table('class_attendance');

CREATE TABLE class_makeup_credits (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  class_enrollment_id uuid NOT NULL,
  source_attendance_id uuid NOT NULL,
  expires_on date NOT NULL,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','booked','redeemed','expired','revoked')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,source_attendance_id),
  FOREIGN KEY (org_id,class_enrollment_id) REFERENCES class_enrollments(org_id,id),
  FOREIGN KEY (org_id,source_attendance_id) REFERENCES class_attendance(org_id,id)
);
CREATE INDEX class_makeup_credits_available_idx ON class_makeup_credits(org_id,class_enrollment_id,expires_on) WHERE status = 'available';
SELECT configure_spine_tenant_table('class_makeup_credits');

CREATE TABLE class_makeup_bookings (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  makeup_credit_id uuid NOT NULL,
  class_session_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','attended','canceled')),
  booked_by uuid NOT NULL REFERENCES accounts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,makeup_credit_id),
  FOREIGN KEY (org_id,makeup_credit_id) REFERENCES class_makeup_credits(org_id,id),
  FOREIGN KEY (org_id,class_session_id) REFERENCES class_sessions(org_id,id)
);
CREATE INDEX class_makeup_bookings_session_idx ON class_makeup_bookings(org_id,class_session_id,status);
SELECT configure_spine_tenant_table('class_makeup_bookings');

CREATE TABLE class_skill_definitions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid NOT NULL,
  level text NOT NULL,
  skill_key text NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,program_id,level,skill_key),
  FOREIGN KEY (org_id,program_id) REFERENCES programs(org_id,id)
);
CREATE INDEX class_skill_definitions_level_idx ON class_skill_definitions(org_id,program_id,level,sort_order) WHERE active;
SELECT configure_spine_tenant_table('class_skill_definitions');

CREATE TABLE class_skill_records (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  class_enrollment_id uuid NOT NULL,
  skill_definition_id uuid NOT NULL,
  proficiency text NOT NULL CHECK (proficiency IN ('not_started','learning','achieved','mastered')),
  evaluated_by uuid NOT NULL REFERENCES accounts(id),
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  notes text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  UNIQUE (org_id,class_enrollment_id,skill_definition_id),
  FOREIGN KEY (org_id,class_enrollment_id) REFERENCES class_enrollments(org_id,id),
  FOREIGN KEY (org_id,skill_definition_id) REFERENCES class_skill_definitions(org_id,id)
);
CREATE INDEX class_skill_records_enrollment_idx ON class_skill_records(org_id,class_enrollment_id,evaluated_at DESC);
SELECT configure_spine_tenant_table('class_skill_records');

CREATE TABLE class_level_recommendations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  class_enrollment_id uuid NOT NULL,
  from_level text NOT NULL,
  recommended_level text NOT NULL,
  instructor_account_id uuid NOT NULL REFERENCES accounts(id),
  status text NOT NULL DEFAULT 'pending_guardian' CHECK (status IN ('pending_guardian','confirmed','declined','applied')),
  guardian_decision_by uuid REFERENCES accounts(id),
  guardian_decision_at timestamptz,
  applied_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  FOREIGN KEY (org_id,class_enrollment_id) REFERENCES class_enrollments(org_id,id)
);
CREATE INDEX class_level_recommendations_pending_idx ON class_level_recommendations(org_id,status,created_at);
SELECT configure_spine_tenant_table('class_level_recommendations');
