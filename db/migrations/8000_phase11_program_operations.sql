CREATE TABLE volunteer_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  description text,
  minimum_age smallint NOT NULL DEFAULT 18 CHECK (minimum_age BETWEEN 0 AND 120),
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, name)
);
CREATE INDEX volunteer_roles_active_idx ON volunteer_roles(org_id, name) WHERE archived_at IS NULL;
SELECT configure_spine_tenant_table('volunteer_roles');

CREATE TABLE volunteer_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  season_id uuid,
  program_id uuid,
  unit text NOT NULL CHECK (unit IN ('hours', 'shifts')),
  amount_per_household numeric(8,2) CHECK (amount_per_household IS NULL OR amount_per_household > 0),
  amount_per_athlete numeric(8,2) CHECK (amount_per_athlete IS NULL OR amount_per_athlete > 0),
  buyout_price_cents bigint CHECK (buyout_price_cents IS NULL OR buyout_price_cents > 0),
  buyout_offering_id uuid,
  deadline date NOT NULL,
  auto_invoice_shortfall boolean NOT NULL DEFAULT false,
  notice_days smallint NOT NULL DEFAULT 14 CHECK (notice_days BETWEEN 1 AND 90),
  counts_coach_roles boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK ((season_id IS NOT NULL) <> (program_id IS NOT NULL)),
  CHECK ((amount_per_household IS NOT NULL) <> (amount_per_athlete IS NOT NULL)),
  FOREIGN KEY (org_id, season_id) REFERENCES seasons(org_id, id),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id),
  FOREIGN KEY (org_id, buyout_offering_id) REFERENCES registration_offerings(org_id, id)
);
CREATE INDEX volunteer_requirements_scope_idx ON volunteer_requirements(org_id, season_id, program_id, deadline);
SELECT configure_spine_tenant_table('volunteer_requirements');

CREATE TABLE volunteer_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  volunteer_role_id uuid NOT NULL,
  event_id uuid,
  facility_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  slots integer NOT NULL CHECK (slots > 0),
  credit_hours numeric(6,2) NOT NULL DEFAULT 0 CHECK (credit_hours >= 0),
  notes text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'completed', 'canceled')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (starts_at < ends_at),
  FOREIGN KEY (org_id, volunteer_role_id) REFERENCES volunteer_roles(org_id, id),
  FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id),
  FOREIGN KEY (org_id, facility_id) REFERENCES facilities(org_id, id)
);
CREATE INDEX volunteer_shifts_schedule_idx ON volunteer_shifts(org_id, starts_at, status);
CREATE INDEX volunteer_shifts_role_idx ON volunteer_shifts(org_id, volunteer_role_id, starts_at);
SELECT configure_spine_tenant_table('volunteer_shifts');

CREATE TABLE volunteer_signups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  volunteer_shift_id uuid NOT NULL,
  person_id uuid NOT NULL,
  household_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'signed_up' CHECK (status IN ('signed_up', 'confirmed', 'checked_in', 'completed', 'no_show', 'canceled')),
  hours_credited numeric(6,2) NOT NULL DEFAULT 0 CHECK (hours_credited >= 0),
  credited_by uuid REFERENCES accounts(id),
  credited_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, volunteer_shift_id) REFERENCES volunteer_shifts(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, household_id) REFERENCES households(org_id, id),
  UNIQUE (org_id, volunteer_shift_id, person_id)
);
CREATE INDEX volunteer_signups_household_idx ON volunteer_signups(org_id, household_id, status, created_at DESC);
CREATE INDEX volunteer_signups_shift_idx ON volunteer_signups(org_id, volunteer_shift_id, status);
SELECT configure_spine_tenant_table('volunteer_signups');

CREATE TABLE volunteer_buyouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  requirement_id uuid NOT NULL,
  household_id uuid NOT NULL,
  person_id uuid,
  units numeric(8,2) NOT NULL CHECK (units > 0),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  invoice_id uuid NOT NULL,
  creation_key uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, creation_key),
  FOREIGN KEY (org_id, requirement_id) REFERENCES volunteer_requirements(org_id, id),
  FOREIGN KEY (org_id, household_id) REFERENCES households(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id)
);
CREATE INDEX volunteer_buyouts_subject_idx ON volunteer_buyouts(org_id, requirement_id, household_id, person_id);
SELECT configure_spine_tenant_table('volunteer_buyouts', true);

CREATE TABLE team_ledgers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  team_season_id uuid NOT NULL,
  budget_cents bigint NOT NULL DEFAULT 0 CHECK (budget_cents >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, team_season_id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id)
);
SELECT configure_spine_tenant_table('team_ledgers');

CREATE TABLE team_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  team_ledger_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('income', 'expense')),
  category text NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 80),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  occurred_on date NOT NULL,
  memo text,
  receipt_file_id uuid,
  source text NOT NULL CHECK (source IN ('team_fee_payment', 'manual', 'reimbursement')),
  payment_id uuid,
  invoice_id uuid,
  invoice_line_id uuid,
  created_by uuid NOT NULL REFERENCES accounts(id),
  approved_by uuid REFERENCES accounts(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, team_ledger_id) REFERENCES team_ledgers(org_id, id),
  FOREIGN KEY (org_id, receipt_file_id) REFERENCES files(org_id, id),
  FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id),
  FOREIGN KEY (org_id, invoice_line_id) REFERENCES invoice_lines(org_id, id),
  CHECK ((source = 'team_fee_payment' AND payment_id IS NOT NULL) OR source <> 'team_fee_payment')
);
CREATE UNIQUE INDEX team_ledger_payment_once_idx ON team_ledger_entries(org_id, team_ledger_id, invoice_line_id, payment_id) WHERE payment_id IS NOT NULL;
CREATE INDEX team_ledger_entries_list_idx ON team_ledger_entries(org_id, team_ledger_id, occurred_on DESC, created_at DESC);
SELECT configure_spine_tenant_table('team_ledger_entries');

CREATE TABLE team_fee_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  team_season_id uuid NOT NULL,
  per_player_cents bigint NOT NULL CHECK (per_player_cents > 0),
  due_on date NOT NULL,
  installment_template_id uuid,
  installment_plan jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'canceled')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id),
  FOREIGN KEY (org_id, installment_template_id) REFERENCES installment_plan_templates(org_id, id),
  CHECK (installment_plan IS NULL OR jsonb_typeof(installment_plan) = 'object')
);
CREATE INDEX team_fee_assessments_team_idx ON team_fee_assessments(org_id, team_season_id, status, created_at DESC);
SELECT configure_spine_tenant_table('team_fee_assessments');

CREATE TABLE team_fee_obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  assessment_id uuid NOT NULL,
  team_ledger_id uuid NOT NULL,
  person_id uuid NOT NULL,
  household_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  invoice_id uuid NOT NULL,
  invoice_line_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, assessment_id, person_id),
  FOREIGN KEY (org_id, assessment_id) REFERENCES team_fee_assessments(org_id, id),
  FOREIGN KEY (org_id, team_ledger_id) REFERENCES team_ledgers(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, household_id) REFERENCES households(org_id, id),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id),
  FOREIGN KEY (org_id, invoice_line_id) REFERENCES invoice_lines(org_id, id)
);
CREATE INDEX team_fee_obligations_invoice_idx ON team_fee_obligations(org_id, invoice_id);
CREATE INDEX team_fee_obligations_household_idx ON team_fee_obligations(org_id, household_id, created_at DESC);
SELECT configure_spine_tenant_table('team_fee_obligations', true);

CREATE TABLE reimbursement_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  team_ledger_id uuid NOT NULL,
  requester_account_id uuid NOT NULL REFERENCES accounts(id),
  requester_person_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  category text NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 80),
  memo text NOT NULL CHECK (length(trim(memo)) > 0),
  receipt_file_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected', 'paid')),
  decision_reason text,
  decided_by uuid REFERENCES accounts(id),
  decided_at timestamptz,
  ledger_entry_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, team_ledger_id) REFERENCES team_ledgers(org_id, id),
  FOREIGN KEY (org_id, requester_person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, receipt_file_id) REFERENCES files(org_id, id),
  FOREIGN KEY (org_id, ledger_entry_id) REFERENCES team_ledger_entries(org_id, id),
  CHECK ((status = 'submitted' AND decided_at IS NULL) OR status <> 'submitted')
);
CREATE INDEX reimbursement_requests_review_idx ON reimbursement_requests(org_id, status, created_at);
CREATE INDEX reimbursement_requests_team_idx ON reimbursement_requests(org_id, team_ledger_id, created_at DESC);
SELECT configure_spine_tenant_table('reimbursement_requests');

CREATE TABLE fundraising_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  goal_cents bigint NOT NULL CHECK (goal_cents > 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  team_season_id uuid,
  description_html text NOT NULL DEFAULT '',
  image_file_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'ended', 'archived')),
  show_donor_names boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, slug),
  CHECK (ends_at IS NULL OR starts_at < ends_at),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id),
  FOREIGN KEY (org_id, image_file_id) REFERENCES files(org_id, id)
);
CREATE INDEX fundraising_campaign_public_idx ON fundraising_campaigns(org_id, status, starts_at, ends_at);
SELECT configure_spine_tenant_table('fundraising_campaigns');

CREATE TABLE fundraising_settings (
  org_id uuid PRIMARY KEY REFERENCES organizations(id),
  is_nonprofit boolean NOT NULL DEFAULT false,
  ein_ciphertext bytea,
  ein_nonce bytea,
  ein_key_version text,
  show_full_ein boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((ein_ciphertext IS NULL AND ein_nonce IS NULL AND ein_key_version IS NULL) OR (ein_ciphertext IS NOT NULL AND octet_length(ein_nonce) = 12 AND ein_key_version IS NOT NULL)),
  CHECK (NOT show_full_ein OR (is_nonprofit AND ein_ciphertext IS NOT NULL))
);
SELECT configure_spine_tenant_table('fundraising_settings');

CREATE TABLE donations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  campaign_id uuid NOT NULL,
  donor_account_id uuid REFERENCES accounts(id),
  donor_name text NOT NULL CHECK (length(trim(donor_name)) BETWEEN 1 AND 200),
  donor_email citext NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  anonymous boolean NOT NULL DEFAULT false,
  dedication text,
  invoice_id uuid,
  invoice_line_id uuid,
  payment_id uuid,
  receipt_number text NOT NULL,
  receipt_sent_at timestamptz,
  quid_pro_quo_value_cents bigint NOT NULL DEFAULT 0 CHECK (quid_pro_quo_value_cents >= 0 AND quid_pro_quo_value_cents <= amount_cents),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, receipt_number),
  FOREIGN KEY (org_id, campaign_id) REFERENCES fundraising_campaigns(org_id, id),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id),
  FOREIGN KEY (org_id, invoice_line_id) REFERENCES invoice_lines(org_id, id),
  FOREIGN KEY (org_id, payment_id) REFERENCES payments(org_id, id),
  CHECK ((status = 'paid' AND paid_at IS NOT NULL) OR status <> 'paid')
);
CREATE INDEX donations_campaign_status_idx ON donations(org_id, campaign_id, status, created_at DESC);
CREATE INDEX donations_donor_year_idx ON donations(org_id, donor_email, paid_at DESC) WHERE status = 'paid';
SELECT configure_spine_tenant_table('donations');

CREATE TABLE sponsors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 180),
  contact jsonb NOT NULL DEFAULT '{}'::jsonb,
  logo_file_id uuid,
  website_url text,
  tier text NOT NULL CHECK (length(trim(tier)) BETWEEN 1 AND 80),
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  contract_start date NOT NULL,
  contract_end date NOT NULL,
  placements jsonb NOT NULL DEFAULT '[]'::jsonb,
  invoice_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('prospect', 'active', 'expired', 'archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (contract_start <= contract_end),
  CHECK (jsonb_typeof(contact) = 'object' AND jsonb_typeof(placements) = 'array'),
  FOREIGN KEY (org_id, logo_file_id) REFERENCES files(org_id, id),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id)
);
CREATE INDEX sponsors_renewal_idx ON sponsors(org_id, contract_end, status);
SELECT configure_spine_tenant_table('sponsors');

CREATE TABLE product_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  sort_order integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, name)
);
SELECT configure_spine_tenant_table('product_categories');

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  category_id uuid,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  description text,
  kind text NOT NULL DEFAULT 'spirit_wear' CHECK (kind IN ('uniform', 'spirit_wear', 'other')),
  required_for_registration boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, category_id) REFERENCES product_categories(org_id, id)
);
CREATE INDEX products_active_idx ON products(org_id, active, category_id, name);
SELECT configure_spine_tenant_table('products');

CREATE TABLE product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  product_id uuid NOT NULL,
  sku text NOT NULL CHECK (length(trim(sku)) BETWEEN 1 AND 80),
  size text,
  color text,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_cents bigint NOT NULL CHECK (price_cents >= 0),
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, sku),
  FOREIGN KEY (org_id, product_id) REFERENCES products(org_id, id),
  CHECK (jsonb_typeof(attributes) = 'object')
);
CREATE INDEX product_variants_product_idx ON product_variants(org_id, product_id, archived_at, sku);
SELECT configure_spine_tenant_table('product_variants');

CREATE TABLE inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  product_variant_id uuid NOT NULL,
  movement text NOT NULL CHECK (movement IN ('receive', 'reserve', 'release', 'sell', 'adjust')),
  quantity integer NOT NULL CHECK (quantity <> 0),
  order_line_id uuid,
  memo text,
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, product_variant_id) REFERENCES product_variants(org_id, id),
  CHECK ((movement = 'adjust' AND quantity <> 0) OR (movement <> 'adjust' AND quantity > 0))
);
CREATE INDEX inventory_movements_variant_idx ON inventory_movements(org_id, product_variant_id, created_at, id);
CREATE INDEX inventory_movements_order_idx ON inventory_movements(org_id, order_line_id) WHERE order_line_id IS NOT NULL;
SELECT configure_spine_tenant_table('inventory_movements', true);

CREATE TABLE store_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  household_id uuid,
  registration_id uuid,
  team_season_id uuid,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'awaiting_payment', 'paid', 'fulfilling', 'fulfilled', 'canceled', 'refunded')),
  subtotal_cents bigint NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  tax_cents bigint NOT NULL DEFAULT 0 CHECK (tax_cents >= 0),
  invoice_id uuid,
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, account_id, idempotency_key),
  FOREIGN KEY (org_id, household_id) REFERENCES households(org_id, id),
  FOREIGN KEY (org_id, registration_id) REFERENCES registrations(org_id, id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id),
  FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id)
);
CREATE INDEX store_orders_account_idx ON store_orders(org_id, account_id, created_at DESC);
CREATE INDEX store_orders_fulfillment_idx ON store_orders(org_id, status, created_at);
SELECT configure_spine_tenant_table('store_orders');

CREATE TABLE store_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  order_id uuid NOT NULL,
  product_id uuid NOT NULL,
  product_variant_id uuid NOT NULL,
  registration_id uuid,
  person_id uuid,
  team_season_id uuid,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_amount_cents bigint NOT NULL CHECK (unit_amount_cents >= 0),
  amount_cents bigint NOT NULL CHECK (amount_cents = quantity * unit_amount_cents),
  description text NOT NULL CHECK (length(trim(description)) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, order_id) REFERENCES store_orders(org_id, id),
  FOREIGN KEY (org_id, product_id) REFERENCES products(org_id, id),
  FOREIGN KEY (org_id, product_variant_id) REFERENCES product_variants(org_id, id),
  FOREIGN KEY (org_id, registration_id) REFERENCES registrations(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id)
);
CREATE INDEX store_order_lines_order_idx ON store_order_lines(org_id, order_id);
CREATE INDEX store_order_lines_uniform_idx ON store_order_lines(org_id, team_season_id, product_variant_id) WHERE team_season_id IS NOT NULL;
SELECT configure_spine_tenant_table('store_order_lines');
ALTER TABLE inventory_movements ADD CONSTRAINT inventory_movements_order_line_fk FOREIGN KEY (org_id, order_line_id) REFERENCES store_order_lines(org_id, id);

CREATE TABLE store_fulfillments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  order_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('pickup', 'ship')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'shipped', 'picked_up', 'canceled')),
  tracking_number text,
  fulfilled_by uuid REFERENCES accounts(id),
  fulfilled_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, order_id),
  FOREIGN KEY (org_id, order_id) REFERENCES store_orders(org_id, id),
  CHECK ((status IN ('shipped', 'picked_up') AND fulfilled_at IS NOT NULL) OR status NOT IN ('shipped', 'picked_up'))
);
CREATE INDEX store_fulfillments_status_idx ON store_fulfillments(org_id, status, created_at);
SELECT configure_spine_tenant_table('store_fulfillments');

CREATE TABLE store_registration_addons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  offering_id uuid NOT NULL,
  product_id uuid NOT NULL,
  required boolean NOT NULL DEFAULT false,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, offering_id, product_id),
  FOREIGN KEY (org_id, offering_id) REFERENCES registration_offerings(org_id, id),
  FOREIGN KEY (org_id, product_id) REFERENCES products(org_id, id)
);
SELECT configure_spine_tenant_table('store_registration_addons');

CREATE OR REPLACE FUNCTION guard_inventory_movement() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  on_hand bigint;
  reserved bigint;
  available bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.org_id::text || ':' || NEW.product_variant_id::text, 0));
  SELECT
    COALESCE(sum(CASE WHEN movement = 'receive' THEN quantity WHEN movement = 'sell' THEN -quantity WHEN movement = 'adjust' THEN quantity ELSE 0 END), 0),
    COALESCE(sum(CASE WHEN movement = 'reserve' THEN quantity WHEN movement IN ('release', 'sell') THEN -quantity ELSE 0 END), 0)
  INTO on_hand, reserved
  FROM inventory_movements
  WHERE org_id = NEW.org_id AND product_variant_id = NEW.product_variant_id;
  available := on_hand - reserved;
  IF NEW.movement = 'reserve' AND NEW.quantity > available THEN
    RAISE EXCEPTION 'inventory is insufficient' USING ERRCODE = '23514';
  ELSIF NEW.movement IN ('release', 'sell') AND NEW.quantity > reserved THEN
    RAISE EXCEPTION 'movement exceeds reserved inventory' USING ERRCODE = '23514';
  ELSIF NEW.movement = 'adjust' AND on_hand + NEW.quantity < reserved THEN
    RAISE EXCEPTION 'adjustment would make inventory negative' USING ERRCODE = '23514';
  ELSIF NEW.movement = 'receive' AND NEW.quantity <= 0 THEN
    RAISE EXCEPTION 'received quantity must be positive' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER inventory_movement_balance_guard BEFORE INSERT ON inventory_movements FOR EACH ROW EXECUTE FUNCTION guard_inventory_movement();

CREATE VIEW inventory_balances WITH (security_invoker = true) AS
SELECT org_id, product_variant_id,
  sum(CASE WHEN movement = 'receive' THEN quantity WHEN movement = 'sell' THEN -quantity WHEN movement = 'adjust' THEN quantity ELSE 0 END)::integer AS on_hand,
  sum(CASE WHEN movement = 'reserve' THEN quantity WHEN movement IN ('release', 'sell') THEN -quantity ELSE 0 END)::integer AS reserved,
  sum(CASE WHEN movement = 'receive' THEN quantity WHEN movement = 'sell' THEN -quantity WHEN movement = 'adjust' THEN quantity WHEN movement = 'reserve' THEN -quantity WHEN movement = 'release' THEN quantity ELSE 0 END)::integer AS available
FROM inventory_movements
GROUP BY org_id, product_variant_id;
GRANT SELECT ON inventory_balances TO athlentry_app;
