-- Phase 5 registration: requirements capture, plans, approvals, waitlist offers,
-- add-on selections, team entry invites and the registration notice outbox.

ALTER TABLE checkouts
  ADD COLUMN requirements jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN requirements_completed_at timestamptz,
  ADD COLUMN payment_plan jsonb,
  ADD COLUMN reminder_sent_at timestamptz,
  ADD COLUMN source text NOT NULL DEFAULT 'online'
    CHECK (source IN ('online', 'staff', 'waitlist_offer', 'team_entry')),
  ADD COLUMN payment_due_at timestamptz;

ALTER TABLE waitlist_entries
  ADD COLUMN checkout_id uuid,
  ADD COLUMN expiring_notified_at timestamptz;
ALTER TABLE waitlist_entries
  ADD CONSTRAINT waitlist_entries_checkout_fk
    FOREIGN KEY (org_id, checkout_id) REFERENCES checkouts(org_id, id);
CREATE INDEX waitlist_entries_checkout_idx
  ON waitlist_entries(org_id, checkout_id) WHERE checkout_id IS NOT NULL;

ALTER TABLE registrations
  ADD COLUMN approval_payment_due_at timestamptz,
  ADD COLUMN approval_decision jsonb;

-- Add-on selections (uniform kits and other products chosen at checkout) drive
-- the uniform size report; invoice lines carry the money.
CREATE TABLE registration_add_on_selections (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  registration_id uuid NOT NULL,
  invoice_line_id uuid,
  line_key text NOT NULL,
  name text NOT NULL,
  size text,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_amount_cents bigint NOT NULL CHECK (unit_amount_cents >= 0),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, registration_id) REFERENCES registrations(org_id, id),
  FOREIGN KEY (org_id, invoice_line_id) REFERENCES invoice_lines(org_id, id)
);
CREATE INDEX registration_add_on_selections_registration_idx
  ON registration_add_on_selections(org_id, registration_id);
CREATE INDEX registration_add_on_selections_size_idx
  ON registration_add_on_selections(org_id, line_key, size);
SELECT configure_spine_tenant_table('registration_add_on_selections', true);

-- Captain/player invites for team entries. Tokens are random, hashed at rest,
-- expiring and single-use.
CREATE TABLE team_entry_invites (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  team_entry_id uuid NOT NULL,
  email citext NOT NULL,
  person_id uuid,
  token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'expired', 'canceled')),
  expires_at timestamptz NOT NULL,
  accepted_registration_id uuid,
  invited_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, team_entry_id, email),
  FOREIGN KEY (org_id, team_entry_id) REFERENCES team_entries(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, accepted_registration_id)
    REFERENCES registrations(org_id, id)
);
CREATE UNIQUE INDEX team_entry_invites_token_idx
  ON team_entry_invites(token_hash) WHERE status = 'pending';
CREATE INDEX team_entry_invites_entry_idx
  ON team_entry_invites(org_id, team_entry_id, status);
CREATE INDEX team_entry_invites_expiry_idx
  ON team_entry_invites(expires_at) WHERE status = 'pending';
SELECT configure_spine_tenant_table('team_entry_invites', true);

-- Tenant-scoped registration notice outbox, mirroring the finance pattern:
-- every family-facing email/in-app intent commits inside the same transaction
-- as its source change, dedupes on (kind, source) and sends through the fake or
-- preview adapter only.
CREATE TABLE registration_notice_outbox (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  kind text NOT NULL CHECK (kind IN (
    'registration_confirmed', 'registration_pending_approval',
    'payment_link', 'waitlist_joined', 'waitlist_offer',
    'waitlist_offer_expiring', 'approval_approved', 'approval_declined',
    'registration_canceled', 'registration_transferred',
    'checkout_reminder', 'team_entry_invite', 'team_entry_status')),
  source_id uuid NOT NULL,
  message_key uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'suppressed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token uuid,
  lease_until timestamptz,
  provider_message_id text,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, kind, source_id),
  UNIQUE (message_key),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);
CREATE INDEX registration_notice_outbox_due_idx
  ON registration_notice_outbox(org_id, created_at)
  WHERE status IN ('queued', 'failed', 'sending');
SELECT configure_spine_tenant_table('registration_notice_outbox', true);

-- One active family-initiated or staff transfer per registration; the result
-- snapshot and the idempotency key make retries exact.
CREATE INDEX transfers_result_idx ON transfers(org_id, created_at DESC);

-- Approvals pay-by deadline index for the sweeper job.
CREATE INDEX registrations_approval_due_idx
  ON registrations(org_id, approval_payment_due_at)
  WHERE status = 'pending_payment' AND approval_payment_due_at IS NOT NULL;

-- Incomplete-checkout reminder index (24 h after start, once).
CREATE INDEX checkouts_reminder_idx
  ON checkouts(org_id, created_at)
  WHERE status = 'awaiting_payment' AND reminder_sent_at IS NULL;
