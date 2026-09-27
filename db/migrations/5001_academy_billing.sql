-- Phase 12 academy / class mode (Track I): enrollments, waitlists,
-- tuition subscriptions, session bookings, make-up credits and punch cards.

CREATE TABLE tuition_subscriptions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  household_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  billing_day integer NOT NULL CHECK (billing_day BETWEEN 1 AND 28),
  payment_method_id uuid REFERENCES payment_methods(id),
  next_bill_on date NOT NULL,
  proration text NOT NULL DEFAULT 'session_count' CHECK (proration IN ('session_count', 'full_month', 'no_charge_after_20th')),
  withdrawal_notice_days integer NOT NULL DEFAULT 30 CHECK (withdrawal_notice_days >= 0),
  paused_until date,
  mandate_text_version text,
  mandate_accepted_at timestamptz,
  tier_change_mode text NOT NULL DEFAULT 'next_billing_date' CHECK (tier_change_mode IN ('next_billing_date', 'immediate')),
  ended_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, household_id) REFERENCES households(org_id, id)
);
CREATE INDEX tuition_subscriptions_billing_idx ON tuition_subscriptions(org_id, next_bill_on) WHERE status = 'active';
CREATE INDEX tuition_subscriptions_household_idx ON tuition_subscriptions(org_id, household_id) WHERE status <> 'ended';
CREATE INDEX tuition_subscriptions_account_idx ON tuition_subscriptions(account_id) WHERE status <> 'ended';
SELECT configure_spine_tenant_table('tuition_subscriptions');

CREATE TABLE class_enrollments (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  class_offering_id uuid NOT NULL,
  person_id uuid NOT NULL,
  household_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('trial', 'active', 'paused', 'withdrawn', 'ended')),
  starts_on date NOT NULL,
  ends_on date,
  withdraw_effective_on date,
  withdrawn_at timestamptz,
  withdrawal_reason text,
  pause_from date,
  pause_to date,
  classes_per_week integer NOT NULL DEFAULT 1 CHECK (classes_per_week > 0),
  billing_subscription_id uuid,
  trial_session_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (ends_on IS NULL OR starts_on <= ends_on),
  CHECK (pause_from IS NULL OR pause_to IS NULL OR pause_from <= pause_to),
  FOREIGN KEY (org_id, class_offering_id) REFERENCES class_offerings(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, household_id) REFERENCES households(org_id, id),
  FOREIGN KEY (org_id, billing_subscription_id) REFERENCES tuition_subscriptions(org_id, id)
);
CREATE UNIQUE INDEX class_enrollments_live_idx ON class_enrollments(org_id, class_offering_id, person_id) WHERE status IN ('trial', 'active', 'paused');
CREATE INDEX class_enrollments_person_idx ON class_enrollments(org_id, person_id, status);
CREATE INDEX class_enrollments_household_idx ON class_enrollments(org_id, household_id, status);
CREATE INDEX class_enrollments_subscription_idx ON class_enrollments(org_id, billing_subscription_id) WHERE billing_subscription_id IS NOT NULL;
SELECT configure_spine_tenant_table('class_enrollments');

CREATE TABLE class_waitlist_entries (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  class_offering_id uuid NOT NULL,
  person_id uuid NOT NULL,
  household_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  position integer NOT NULL CHECK (position > 0),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'offered', 'accepted', 'expired', 'declined', 'removed')),
  offered_at timestamptz,
  offer_expires_at timestamptz,
  enrollment_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, class_offering_id) REFERENCES class_offerings(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, household_id) REFERENCES households(org_id, id),
  FOREIGN KEY (org_id, enrollment_id) REFERENCES class_enrollments(org_id, id)
);
CREATE UNIQUE INDEX class_waitlist_live_person_idx ON class_waitlist_entries(org_id, class_offering_id, person_id) WHERE status IN ('waiting', 'offered');
CREATE UNIQUE INDEX class_waitlist_live_position_idx ON class_waitlist_entries(org_id, class_offering_id, position) WHERE status IN ('waiting', 'offered');
CREATE INDEX class_waitlist_offering_idx ON class_waitlist_entries(org_id, class_offering_id, status, position);
SELECT configure_spine_tenant_table('class_waitlist_entries');

CREATE TABLE class_session_bookings (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  class_session_id uuid NOT NULL,
  person_id uuid NOT NULL,
  household_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  kind text NOT NULL CHECK (kind IN ('drop_in', 'makeup', 'trial')),
  makeup_credit_id uuid,
  punch_card_id uuid,
  invoice_id uuid,
  status text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'attended', 'canceled', 'no_show')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, class_session_id) REFERENCES class_sessions(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, household_id) REFERENCES households(org_id, id),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id)
);
CREATE UNIQUE INDEX class_session_bookings_live_idx ON class_session_bookings(org_id, class_session_id, person_id) WHERE status IN ('booked', 'attended');
CREATE INDEX class_session_bookings_session_idx ON class_session_bookings(org_id, class_session_id, status);
CREATE INDEX class_session_bookings_person_idx ON class_session_bookings(org_id, person_id, status);
SELECT configure_spine_tenant_table('class_session_bookings');

CREATE TABLE makeup_credits (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  person_id uuid NOT NULL,
  class_offering_id uuid NOT NULL,
  source_event_id uuid NOT NULL,
  expires_on date NOT NULL,
  used_event_id uuid,
  used_at timestamptz,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'used', 'expired', 'revoked')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, person_id, source_event_id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, class_offering_id) REFERENCES class_offerings(org_id, id),
  FOREIGN KEY (org_id, source_event_id) REFERENCES events(org_id, id),
  FOREIGN KEY (org_id, used_event_id) REFERENCES events(org_id, id)
);
CREATE INDEX makeup_credits_person_idx ON makeup_credits(org_id, person_id, status, expires_on);
CREATE INDEX makeup_credits_expiry_idx ON makeup_credits(org_id, status, expires_on) WHERE status = 'available';
SELECT configure_spine_tenant_table('makeup_credits');

CREATE TABLE punch_cards (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  household_id uuid NOT NULL,
  person_id uuid NOT NULL,
  class_offering_id uuid NOT NULL,
  total_uses integer NOT NULL CHECK (total_uses > 0),
  remaining_uses integer NOT NULL CHECK (remaining_uses >= 0),
  invoice_id uuid NOT NULL,
  expires_on date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'exhausted', 'expired', 'canceled')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (remaining_uses <= total_uses),
  FOREIGN KEY (org_id, household_id) REFERENCES households(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, class_offering_id) REFERENCES class_offerings(org_id, id),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id)
);
CREATE INDEX punch_cards_person_idx ON punch_cards(org_id, person_id, status);
CREATE INDEX punch_cards_offering_idx ON punch_cards(org_id, class_offering_id, status);
SELECT configure_spine_tenant_table('punch_cards');

ALTER TABLE class_session_bookings
  ADD CONSTRAINT class_session_bookings_credit_fk
  FOREIGN KEY (org_id, makeup_credit_id) REFERENCES makeup_credits(org_id, id),
  ADD CONSTRAINT class_session_bookings_punch_fk
  FOREIGN KEY (org_id, punch_card_id) REFERENCES punch_cards(org_id, id);
