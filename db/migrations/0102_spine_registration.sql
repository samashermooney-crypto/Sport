CREATE TABLE checkouts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'awaiting_payment', 'completed', 'expired', 'abandoned', 'failed')),
  expires_at timestamptz NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  pricing_snapshot jsonb,
  payment_plan_choice jsonb,
  payment_intent_id text,
  idempotency_key uuid,
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, account_id, idempotency_key),
  CHECK (status <> 'awaiting_payment' OR pricing_snapshot IS NOT NULL)
);
CREATE INDEX checkouts_account_status_idx ON checkouts(org_id, account_id, status, updated_at DESC);
CREATE INDEX checkouts_expiry_idx ON checkouts(org_id, expires_at) WHERE status IN ('open', 'awaiting_payment');
SELECT configure_spine_tenant_table('checkouts');

CREATE TABLE registrations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid NOT NULL,
  division_id uuid NOT NULL,
  offering_id uuid NOT NULL,
  person_id uuid NOT NULL,
  household_id uuid NOT NULL,
  registered_by_account_id uuid NOT NULL REFERENCES accounts(id),
  source text NOT NULL CHECK (source IN ('online', 'staff', 'import', 'offer_acceptance', 'transfer')),
  status text NOT NULL CHECK (status IN ('pending_payment', 'pending_approval', 'waitlisted', 'offered', 'confirmed', 'canceled', 'withdrawn', 'transferred_out')),
  status_reason text,
  team_season_id uuid,
  checkout_id uuid,
  invoice_line_id uuid,
  transferred_from_id uuid,
  canceled_at timestamptz,
  canceled_by uuid REFERENCES accounts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id),
  FOREIGN KEY (org_id, division_id) REFERENCES divisions(org_id, id),
  FOREIGN KEY (org_id, offering_id) REFERENCES registration_offerings(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, household_id) REFERENCES households(org_id, id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id),
  FOREIGN KEY (org_id, checkout_id) REFERENCES checkouts(org_id, id),
  FOREIGN KEY (org_id, transferred_from_id) REFERENCES registrations(org_id, id)
);
CREATE UNIQUE INDEX registrations_active_person_idx ON registrations(org_id, program_id, person_id) WHERE status NOT IN ('canceled', 'withdrawn', 'transferred_out');
CREATE INDEX registrations_program_status_idx ON registrations(org_id, program_id, status, created_at DESC);
CREATE INDEX registrations_household_idx ON registrations(org_id, household_id, status);
CREATE INDEX registrations_offering_idx ON registrations(org_id, offering_id, status);
CREATE INDEX registrations_division_idx ON registrations(org_id, division_id, status);
CREATE INDEX registrations_person_idx ON registrations(org_id, person_id, status);
CREATE INDEX registrations_checkout_idx ON registrations(org_id, checkout_id) WHERE checkout_id IS NOT NULL;
CREATE INDEX registrations_team_idx ON registrations(org_id, team_season_id) WHERE team_season_id IS NOT NULL;
CREATE INDEX registrations_invoice_line_idx ON registrations(org_id, invoice_line_id) WHERE invoice_line_id IS NOT NULL;
CREATE INDEX registrations_transfer_idx ON registrations(org_id, transferred_from_id) WHERE transferred_from_id IS NOT NULL;
SELECT configure_spine_tenant_table('registrations');

ALTER TABLE roster_entries ADD CONSTRAINT roster_entries_registration_fk
  FOREIGN KEY (org_id, registration_id) REFERENCES registrations(org_id, id);
ALTER TABLE waiver_signatures ADD CONSTRAINT waiver_signatures_registration_fk
  FOREIGN KEY (org_id, registration_id) REFERENCES registrations(org_id, id);

CREATE TABLE registration_status_history (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  registration_id uuid NOT NULL,
  from_status text CHECK (from_status IN ('pending_payment', 'pending_approval', 'waitlisted', 'offered', 'confirmed', 'canceled', 'withdrawn', 'transferred_out')),
  to_status text NOT NULL CHECK (to_status IN ('pending_payment', 'pending_approval', 'waitlisted', 'offered', 'confirmed', 'canceled', 'withdrawn', 'transferred_out')),
  actor_account_id uuid REFERENCES accounts(id),
  reason text,
  changed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, registration_id) REFERENCES registrations(org_id, id)
);
CREATE INDEX registration_status_history_registration_idx ON registration_status_history(org_id, registration_id, changed_at DESC);
SELECT configure_spine_tenant_table('registration_status_history', true);

CREATE TABLE capacity_holds (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  checkout_id uuid NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('offering', 'division', 'program', 'class_session', 'evaluation_session', 'volunteer_shift')),
  subject_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  expires_at timestamptz NOT NULL,
  released_at timestamptz,
  converted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (released_at IS NULL OR converted_at IS NULL),
  FOREIGN KEY (org_id, checkout_id) REFERENCES checkouts(org_id, id)
);
CREATE INDEX capacity_holds_checkout_idx ON capacity_holds(org_id, checkout_id);
CREATE INDEX capacity_holds_subject_idx ON capacity_holds(org_id, subject_type, subject_id) WHERE released_at IS NULL AND converted_at IS NULL;
CREATE INDEX capacity_holds_expiry_idx ON capacity_holds(org_id, expires_at) WHERE released_at IS NULL AND converted_at IS NULL;
SELECT configure_spine_tenant_table('capacity_holds');

CREATE TABLE waitlist_entries (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  offering_id uuid NOT NULL,
  person_id uuid NOT NULL,
  household_id uuid NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'offered', 'accepted', 'expired', 'declined', 'removed')),
  offered_at timestamptz,
  offer_expires_at timestamptz,
  registration_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, offering_id) REFERENCES registration_offerings(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, household_id) REFERENCES households(org_id, id),
  FOREIGN KEY (org_id, registration_id) REFERENCES registrations(org_id, id)
);
CREATE UNIQUE INDEX waitlist_entries_live_person_idx ON waitlist_entries(org_id, offering_id, person_id) WHERE status IN ('waiting', 'offered');
CREATE UNIQUE INDEX waitlist_entries_live_position_idx ON waitlist_entries(org_id, offering_id, position) WHERE status IN ('waiting', 'offered');
CREATE INDEX waitlist_entries_offering_idx ON waitlist_entries(org_id, offering_id, status, position);
CREATE INDEX waitlist_entries_person_idx ON waitlist_entries(org_id, person_id);
CREATE INDEX waitlist_entries_household_idx ON waitlist_entries(org_id, household_id);
CREATE INDEX waitlist_entries_registration_idx ON waitlist_entries(org_id, registration_id) WHERE registration_id IS NOT NULL;
SELECT configure_spine_tenant_table('waitlist_entries');

CREATE TABLE registration_approvals (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  registration_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'declined')),
  decided_by uuid NOT NULL REFERENCES accounts(id),
  note text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, registration_id),
  FOREIGN KEY (org_id, registration_id) REFERENCES registrations(org_id, id)
);
SELECT configure_spine_tenant_table('registration_approvals', true);

CREATE TABLE team_entries (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid NOT NULL,
  division_id uuid NOT NULL,
  offering_id uuid NOT NULL,
  team_season_id uuid,
  external_team_id uuid,
  entrant_org_id uuid REFERENCES organizations(id),
  captain_person_id uuid,
  contact_account_id uuid REFERENCES accounts(id),
  status text NOT NULL CHECK (status IN ('pending_payment', 'pending_approval', 'accepted', 'waitlisted', 'withdrawn', 'declined')),
  seed_hint integer,
  invoice_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK ((team_season_id IS NOT NULL) <> (external_team_id IS NOT NULL)),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id),
  FOREIGN KEY (org_id, division_id) REFERENCES divisions(org_id, id),
  FOREIGN KEY (org_id, offering_id) REFERENCES registration_offerings(org_id, id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id),
  FOREIGN KEY (org_id, external_team_id) REFERENCES external_teams(org_id, id),
  FOREIGN KEY (org_id, captain_person_id) REFERENCES people(org_id, id)
);
CREATE INDEX team_entries_program_idx ON team_entries(org_id, program_id, status);
CREATE INDEX team_entries_division_idx ON team_entries(org_id, division_id);
CREATE INDEX team_entries_offering_idx ON team_entries(org_id, offering_id);
CREATE INDEX team_entries_team_idx ON team_entries(org_id, team_season_id) WHERE team_season_id IS NOT NULL;
CREATE INDEX team_entries_external_idx ON team_entries(org_id, external_team_id) WHERE external_team_id IS NOT NULL;
CREATE INDEX team_entries_invoice_idx ON team_entries(org_id, invoice_id) WHERE invoice_id IS NOT NULL;
SELECT configure_spine_tenant_table('team_entries');

CREATE TABLE transfers (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  from_registration_id uuid NOT NULL,
  to_registration_id uuid NOT NULL,
  financial_treatment text NOT NULL CHECK (financial_treatment IN ('carry_payment', 'refund_difference', 'charge_difference', 'no_change')),
  performed_by uuid NOT NULL REFERENCES accounts(id),
  idempotency_key uuid NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, idempotency_key),
  CHECK (from_registration_id <> to_registration_id),
  FOREIGN KEY (org_id, from_registration_id) REFERENCES registrations(org_id, id),
  FOREIGN KEY (org_id, to_registration_id) REFERENCES registrations(org_id, id)
);
CREATE INDEX transfers_from_idx ON transfers(org_id, from_registration_id);
CREATE INDEX transfers_to_idx ON transfers(org_id, to_registration_id);
SELECT configure_spine_tenant_table('transfers', true);
