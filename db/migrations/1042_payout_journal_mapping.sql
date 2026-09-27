CREATE TABLE payout_journal_mappings (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL UNIQUE REFERENCES organizations(id),
  bank text NOT NULL CHECK (length(trim(bank)) > 0),
  stripe_clearing text NOT NULL CHECK (length(trim(stripe_clearing)) > 0),
  processing_fees text NOT NULL CHECK (length(trim(processing_fees)) > 0),
  transaction_types jsonb NOT NULL CHECK (jsonb_typeof(transaction_types) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
SELECT configure_spine_tenant_table('payout_journal_mappings');
