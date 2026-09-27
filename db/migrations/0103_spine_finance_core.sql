CREATE TABLE payment_accounts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL UNIQUE REFERENCES organizations(id),
  provider text NOT NULL DEFAULT 'stripe' CHECK (provider = 'stripe'),
  stripe_account_id text UNIQUE,
  charges_enabled boolean NOT NULL DEFAULT false,
  payouts_enabled boolean NOT NULL DEFAULT false,
  details_submitted boolean NOT NULL DEFAULT false,
  requirements jsonb NOT NULL DEFAULT '{}'::jsonb,
  statement_descriptor text,
  default_currency text NOT NULL DEFAULT 'USD' CHECK (default_currency = 'USD'),
  onboarding_status text NOT NULL DEFAULT 'not_started' CHECK (onboarding_status IN ('not_started', 'pending', 'restricted', 'active', 'disabled')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
SELECT configure_spine_tenant_table('payment_accounts');

CREATE TABLE payer_profiles (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE REFERENCES accounts(id),
  stripe_customer_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER payer_profiles_set_updated_at BEFORE UPDATE ON payer_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE ON payer_profiles TO athlentry_app;

CREATE TABLE payment_methods (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id),
  stripe_payment_method_id text NOT NULL UNIQUE,
  type text NOT NULL CHECK (type IN ('card', 'us_bank_account', 'link')),
  brand text,
  last4 text CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$'),
  exp_month integer CHECK (exp_month IS NULL OR exp_month BETWEEN 1 AND 12),
  exp_year integer,
  bank_name text,
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'detached', 'failed_verification')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_methods_default_idx ON payment_methods(account_id) WHERE is_default AND status = 'active';
CREATE INDEX payment_methods_account_idx ON payment_methods(account_id, status);
CREATE TRIGGER payment_methods_set_updated_at BEFORE UPDATE ON payment_methods FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE ON payment_methods TO athlentry_app;

CREATE TABLE installment_plan_templates (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  kind text NOT NULL CHECK (kind IN ('fixed_dates', 'monthly', 'weekly')),
  deposit jsonb NOT NULL DEFAULT '{}'::jsonb,
  schedule jsonb NOT NULL DEFAULT '{}'::jsonb,
  min_amount_cents bigint NOT NULL DEFAULT 0 CHECK (min_amount_cents >= 0),
  autopay_required boolean NOT NULL DEFAULT false,
  allowed_methods text[] NOT NULL DEFAULT ARRAY['card'],
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX installment_plan_templates_active_idx ON installment_plan_templates(org_id, active, name);
SELECT configure_spine_tenant_table('installment_plan_templates');

CREATE TABLE invoices (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  number bigint NOT NULL CHECK (number > 0),
  account_id uuid NOT NULL REFERENCES accounts(id),
  household_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'paid', 'partially_paid', 'past_due', 'void', 'uncollectible')),
  issued_at timestamptz,
  due_on date,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  subtotal_cents bigint NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  discount_cents bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  service_fee_cents bigint NOT NULL DEFAULT 0 CHECK (service_fee_cents >= 0),
  tax_cents bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  total_cents bigint NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  paid_cents bigint NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  refunded_cents bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  credit_applied_cents bigint NOT NULL DEFAULT 0 CHECK (credit_applied_cents >= 0),
  balance_cents bigint GENERATED ALWAYS AS (total_cents - paid_cents - credit_applied_cents + refunded_cents) STORED,
  memo text,
  source text NOT NULL CHECK (source IN ('checkout', 'staff', 'installment_rollover', 'team_fee', 'tuition', 'order', 'donation')),
  voided_at timestamptz,
  void_reason text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, number),
  CHECK (balance_cents >= 0),
  CHECK (total_cents = subtotal_cents - discount_cents + service_fee_cents + tax_cents),
  CHECK (refunded_cents <= paid_cents),
  FOREIGN KEY (org_id, household_id) REFERENCES households(org_id, id)
);
CREATE INDEX invoices_account_status_idx ON invoices(org_id, account_id, status, created_at DESC);
CREATE INDEX invoices_household_idx ON invoices(org_id, household_id, status) WHERE household_id IS NOT NULL;
CREATE INDEX invoices_due_idx ON invoices(org_id, due_on, status) WHERE status IN ('open', 'partially_paid', 'past_due');
SELECT configure_spine_tenant_table('invoices');
ALTER TABLE team_entries ADD CONSTRAINT team_entries_invoice_fk FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id);

CREATE TABLE invoice_lines (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  invoice_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('registration', 'add_on', 'product', 'team_fee', 'tuition', 'volunteer_buyout', 'donation', 'service_fee', 'late_fee', 'adjustment', 'discount', 'aid')),
  description text NOT NULL CHECK (length(trim(description)) > 0),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_amount_cents bigint NOT NULL,
  amount_cents bigint NOT NULL,
  registration_id uuid,
  person_id uuid,
  program_id uuid,
  team_season_id uuid,
  product_variant_id uuid,
  gl_code text,
  tax_rate_bps integer CHECK (tax_rate_bps IS NULL OR tax_rate_bps BETWEEN 0 AND 10000),
  refundable boolean NOT NULL DEFAULT true,
  parent_line_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (amount_cents = quantity * unit_amount_cents),
  CHECK ((kind IN ('discount', 'aid') AND amount_cents <= 0) OR (kind NOT IN ('discount', 'aid') AND amount_cents >= 0)),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id),
  FOREIGN KEY (org_id, registration_id) REFERENCES registrations(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id),
  FOREIGN KEY (org_id, parent_line_id) REFERENCES invoice_lines(org_id, id)
);
CREATE INDEX invoice_lines_invoice_idx ON invoice_lines(org_id, invoice_id, kind);
CREATE INDEX invoice_lines_registration_idx ON invoice_lines(org_id, registration_id) WHERE registration_id IS NOT NULL;
CREATE INDEX invoice_lines_person_idx ON invoice_lines(org_id, person_id) WHERE person_id IS NOT NULL;
CREATE INDEX invoice_lines_program_idx ON invoice_lines(org_id, program_id) WHERE program_id IS NOT NULL;
CREATE INDEX invoice_lines_team_idx ON invoice_lines(org_id, team_season_id) WHERE team_season_id IS NOT NULL;
CREATE INDEX invoice_lines_parent_idx ON invoice_lines(org_id, parent_line_id) WHERE parent_line_id IS NOT NULL;
SELECT configure_spine_tenant_table('invoice_lines');
ALTER TABLE registrations ADD CONSTRAINT registrations_invoice_line_fk FOREIGN KEY (org_id, invoice_line_id) REFERENCES invoice_lines(org_id, id);

CREATE TABLE installments (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  invoice_id uuid NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  due_on date NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  paid_cents bigint NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'processing', 'paid', 'failed', 'canceled', 'waived')),
  autopay boolean NOT NULL DEFAULT false,
  payment_method_id uuid REFERENCES payment_methods(id),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz,
  last_failure_code text,
  last_failure_message text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, invoice_id, sequence),
  CHECK (paid_cents <= amount_cents),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id)
);
CREATE INDEX installments_due_idx ON installments(org_id, due_on, status);
CREATE INDEX installments_payment_method_idx ON installments(payment_method_id) WHERE payment_method_id IS NOT NULL;
SELECT configure_spine_tenant_table('installments');

CREATE TABLE payments (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  account_id uuid REFERENCES accounts(id),
  method text NOT NULL CHECK (method IN ('card', 'us_bank_account', 'link', 'apple_pay', 'google_pay', 'cash', 'check', 'external')),
  status text NOT NULL CHECK (status IN ('requires_action', 'processing', 'succeeded', 'failed', 'canceled')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  application_fee_cents bigint NOT NULL DEFAULT 0 CHECK (application_fee_cents >= 0),
  processing_fee_cents bigint NOT NULL DEFAULT 0 CHECK (processing_fee_cents >= 0),
  net_cents bigint NOT NULL DEFAULT 0,
  stripe_payment_intent_id text UNIQUE,
  stripe_charge_id text,
  reference text,
  received_by uuid REFERENCES accounts(id),
  idempotency_key uuid,
  failure_code text,
  failure_message text,
  succeeded_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, idempotency_key),
  CHECK (application_fee_cents + processing_fee_cents <= amount_cents)
);
CREATE INDEX payments_account_idx ON payments(org_id, account_id, created_at DESC) WHERE account_id IS NOT NULL;
CREATE INDEX payments_status_idx ON payments(org_id, status, created_at DESC);
SELECT configure_spine_tenant_table('payments');

CREATE TABLE payment_allocations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  payment_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  installment_id uuid,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id),
  FOREIGN KEY (org_id, installment_id) REFERENCES installments(org_id, id)
);
CREATE INDEX payment_allocations_payment_idx ON payment_allocations(org_id, payment_id);
CREATE INDEX payment_allocations_invoice_idx ON payment_allocations(org_id, invoice_id);
CREATE INDEX payment_allocations_installment_idx ON payment_allocations(org_id, installment_id) WHERE installment_id IS NOT NULL;
SELECT configure_spine_tenant_table('payment_allocations', true);

CREATE TABLE autopay_authorizations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  payment_method_id uuid NOT NULL REFERENCES payment_methods(id),
  invoice_id uuid,
  subscription_id uuid,
  mandate_text_version text NOT NULL,
  authorized_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK ((invoice_id IS NOT NULL) <> (subscription_id IS NOT NULL)),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id)
);
CREATE INDEX autopay_authorizations_account_idx ON autopay_authorizations(org_id, account_id, revoked_at);
CREATE INDEX autopay_authorizations_method_idx ON autopay_authorizations(payment_method_id);
CREATE INDEX autopay_authorizations_invoice_idx ON autopay_authorizations(org_id, invoice_id) WHERE invoice_id IS NOT NULL;
SELECT configure_spine_tenant_table('autopay_authorizations', true);

CREATE TABLE refunds (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  payment_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL CHECK (reason IN ('requested_by_customer', 'duplicate', 'fraudulent', 'program_canceled', 'withdrawal_policy', 'other')),
  note text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled')),
  stripe_refund_id text UNIQUE,
  refund_application_fee boolean NOT NULL DEFAULT false,
  reverse_transfer boolean NOT NULL DEFAULT true,
  allocations jsonb NOT NULL DEFAULT '[]'::jsonb,
  requested_by uuid REFERENCES accounts(id),
  approved_by uuid REFERENCES accounts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id)
);
CREATE INDEX refunds_payment_idx ON refunds(org_id, payment_id, status);
SELECT configure_spine_tenant_table('refunds');

CREATE TABLE disputes (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  payment_id uuid NOT NULL,
  stripe_dispute_id text NOT NULL UNIQUE,
  status text NOT NULL,
  reason text,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  evidence_due_by timestamptz,
  evidence_submitted_at timestamptz,
  outcome text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id)
);
CREATE INDEX disputes_payment_idx ON disputes(org_id, payment_id, status);
CREATE INDEX disputes_due_idx ON disputes(org_id, evidence_due_by) WHERE evidence_submitted_at IS NULL;
SELECT configure_spine_tenant_table('disputes');

CREATE TABLE credits (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  account_id uuid REFERENCES accounts(id),
  household_id uuid,
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
  kind text NOT NULL CHECK (kind IN ('issued', 'applied', 'expired', 'reversed')),
  source text NOT NULL,
  invoice_id uuid,
  expires_on date,
  note text,
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (account_id IS NOT NULL OR household_id IS NOT NULL),
  FOREIGN KEY (org_id, household_id) REFERENCES households(org_id, id),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id)
);
CREATE INDEX credits_account_idx ON credits(org_id, account_id, created_at DESC) WHERE account_id IS NOT NULL;
CREATE INDEX credits_household_idx ON credits(org_id, household_id, created_at DESC) WHERE household_id IS NOT NULL;
CREATE INDEX credits_invoice_idx ON credits(org_id, invoice_id) WHERE invoice_id IS NOT NULL;
SELECT configure_spine_tenant_table('credits', true);

CREATE TABLE stripe_events (
  id uuid PRIMARY KEY,
  stripe_event_id text NOT NULL UNIQUE,
  account text,
  type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stripe_events_unprocessed_idx ON stripe_events(processed_at, received_at) WHERE processed_at IS NULL;
CREATE INDEX stripe_events_account_idx ON stripe_events(account, received_at DESC);
CREATE TRIGGER stripe_events_set_updated_at BEFORE UPDATE ON stripe_events FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE ON stripe_events TO athlentry_app;
