ALTER TABLE stripe_events
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_expires_at timestamptz;

ALTER TABLE stripe_events
  ADD CONSTRAINT stripe_events_lease_pair_check
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL));

CREATE INDEX stripe_events_claim_idx
  ON stripe_events(lease_expires_at, received_at)
  WHERE processed_at IS NULL;
