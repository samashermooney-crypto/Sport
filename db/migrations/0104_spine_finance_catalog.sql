CREATE TABLE discount_codes (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  code citext NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fixed', 'percent')),
  value integer NOT NULL CHECK (value > 0),
  applies_to jsonb NOT NULL DEFAULT '{}'::jsonb,
  starts_at timestamptz,
  ends_at timestamptz,
  max_redemptions integer CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  max_per_account integer CHECK (max_per_account IS NULL OR max_per_account > 0),
  stackable boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, code),
  CHECK (kind <> 'percent' OR value <= 10000),
  CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at)
);
CREATE INDEX discount_codes_active_idx ON discount_codes(org_id, active, starts_at, ends_at);
SELECT configure_spine_tenant_table('discount_codes');

CREATE TABLE discount_redemptions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  discount_code_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  invoice_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, discount_code_id, invoice_id),
  FOREIGN KEY (org_id, discount_code_id) REFERENCES discount_codes(org_id, id),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id)
);
CREATE INDEX discount_redemptions_account_idx ON discount_redemptions(org_id, account_id, discount_code_id);
CREATE INDEX discount_redemptions_invoice_idx ON discount_redemptions(org_id, invoice_id);
SELECT configure_spine_tenant_table('discount_redemptions', true);

CREATE TABLE automatic_discount_rules (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN ('sibling', 'multi_program', 'returning', 'early_bird_override', 'staff_child', 'volunteer_coach_child')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  season_id uuid,
  priority integer NOT NULL DEFAULT 0,
  stackable boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, season_id) REFERENCES seasons(org_id, id)
);
CREATE INDEX automatic_discount_rules_active_idx ON automatic_discount_rules(org_id, active, season_id, priority);
SELECT configure_spine_tenant_table('automatic_discount_rules');

CREATE TABLE financial_aid_programs (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  season_id uuid NOT NULL,
  application_form_id uuid,
  budget_cents bigint NOT NULL DEFAULT 0 CHECK (budget_cents >= 0),
  awarded_cents bigint NOT NULL DEFAULT 0 CHECK (awarded_cents >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed', 'archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (awarded_cents <= budget_cents),
  FOREIGN KEY (org_id, season_id) REFERENCES seasons(org_id, id),
  FOREIGN KEY (org_id, application_form_id) REFERENCES form_definitions(org_id, id)
);
CREATE INDEX financial_aid_programs_season_idx ON financial_aid_programs(org_id, season_id, status);
CREATE INDEX financial_aid_programs_form_idx ON financial_aid_programs(org_id, application_form_id) WHERE application_form_id IS NOT NULL;
SELECT configure_spine_tenant_table('financial_aid_programs');

CREATE TABLE aid_applications (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  financial_aid_program_id uuid NOT NULL,
  household_id uuid NOT NULL,
  program_ids uuid[] NOT NULL DEFAULT '{}',
  requested_cents bigint NOT NULL CHECK (requested_cents >= 0),
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  documents jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'under_review', 'awarded', 'partially_awarded', 'declined', 'withdrawn')),
  award_cents bigint NOT NULL DEFAULT 0 CHECK (award_cents >= 0),
  award_kind text CHECK (award_kind IN ('percent', 'fixed')),
  decided_by uuid REFERENCES accounts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (award_cents <= requested_cents),
  FOREIGN KEY (org_id, financial_aid_program_id) REFERENCES financial_aid_programs(org_id, id),
  FOREIGN KEY (org_id, household_id) REFERENCES households(org_id, id)
);
CREATE INDEX aid_applications_program_idx ON aid_applications(org_id, financial_aid_program_id, status);
CREATE INDEX aid_applications_household_idx ON aid_applications(org_id, household_id, status);
SELECT configure_spine_tenant_table('aid_applications');

CREATE TABLE payouts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  stripe_payout_id text NOT NULL UNIQUE,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  arrival_date date,
  status text NOT NULL,
  balance_transaction_ids text[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX payouts_arrival_idx ON payouts(org_id, arrival_date DESC);
SELECT configure_spine_tenant_table('payouts');

CREATE TABLE balance_transactions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  stripe_balance_transaction_id text NOT NULL UNIQUE,
  stripe_payout_id text,
  type text NOT NULL,
  amount_cents bigint NOT NULL,
  fee_cents bigint NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  net_cents bigint NOT NULL,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  available_on date,
  source_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (net_cents = amount_cents - fee_cents)
);
CREATE INDEX balance_transactions_payout_idx ON balance_transactions(org_id, stripe_payout_id) WHERE stripe_payout_id IS NOT NULL;
CREATE INDEX balance_transactions_source_idx ON balance_transactions(org_id, source_id) WHERE source_id IS NOT NULL;
SELECT configure_spine_tenant_table('balance_transactions');

CREATE TABLE tax_rates (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  rate_bps integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  applies_to text NOT NULL DEFAULT 'products' CHECK (applies_to = 'products'),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX tax_rates_active_idx ON tax_rates(org_id, active, name);
SELECT configure_spine_tenant_table('tax_rates');

CREATE TABLE gl_codes (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  code text NOT NULL CHECK (length(trim(code)) > 0),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  kind text NOT NULL CHECK (kind IN ('income', 'liability', 'expense')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, code)
);
CREATE INDEX gl_codes_kind_idx ON gl_codes(org_id, kind, name);
SELECT configure_spine_tenant_table('gl_codes');
