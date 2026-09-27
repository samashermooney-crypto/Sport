ALTER TABLE payer_profiles
  ALTER COLUMN stripe_customer_id DROP NOT NULL,
  ADD COLUMN customer_claimed_at timestamptz;

ALTER TABLE payer_profiles
  ADD CONSTRAINT payer_profiles_customer_or_claim_check
  CHECK (stripe_customer_id IS NOT NULL OR customer_claimed_at IS NOT NULL);
