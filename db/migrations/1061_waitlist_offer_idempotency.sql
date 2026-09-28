-- Waitlist offer creation is requested by staff but the resulting checkout is
-- owned by the family payer. Keep the action's replay fence on the waitlist row.
ALTER TABLE waitlist_entries
  ADD COLUMN offer_idempotency_key uuid,
  ADD COLUMN offer_request_hash bytea,
  ADD CONSTRAINT waitlist_offer_request_hash_length
    CHECK (offer_request_hash IS NULL OR octet_length(offer_request_hash) = 32),
  ADD CONSTRAINT waitlist_offer_key_hash_pair
    CHECK ((offer_idempotency_key IS NULL) = (offer_request_hash IS NULL));

CREATE UNIQUE INDEX waitlist_offer_idempotency_key_idx
  ON waitlist_entries (org_id, offer_idempotency_key)
  WHERE offer_idempotency_key IS NOT NULL;
