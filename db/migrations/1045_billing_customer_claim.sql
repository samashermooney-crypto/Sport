ALTER TABLE org_subscriptions
  ALTER COLUMN stripe_customer_id DROP NOT NULL,
  ADD COLUMN customer_claim_status text NOT NULL DEFAULT 'complete'
    CHECK (customer_claim_status IN ('reserved', 'external_started', 'complete')),
  ADD COLUMN customer_claim_key text;

ALTER TABLE org_subscriptions
  ADD CONSTRAINT org_subscriptions_customer_claim_check CHECK (
    (customer_claim_status = 'complete' AND stripe_customer_id IS NOT NULL)
    OR (customer_claim_status <> 'complete' AND stripe_customer_id IS NULL
      AND customer_claim_key IS NOT NULL)
  );
