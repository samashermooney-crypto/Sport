-- Phase 5 lifecycle actions need durable replay fences across HTTP retries.
ALTER TABLE registrations
  ADD COLUMN cancel_idempotency_key uuid,
  ADD COLUMN cancel_request_hash bytea,
  ADD COLUMN cancel_result jsonb,
  ADD CONSTRAINT registrations_cancel_hash_length
    CHECK (cancel_request_hash IS NULL OR octet_length(cancel_request_hash) = 32);

ALTER TABLE registration_approvals
  ADD COLUMN idempotency_key uuid,
  ADD COLUMN request_hash bytea,
  ADD CONSTRAINT registration_approvals_request_hash_length
    CHECK (request_hash IS NULL OR octet_length(request_hash) = 32);

ALTER TABLE transfers
  ADD COLUMN request_hash bytea,
  ADD CONSTRAINT transfers_request_hash_length
    CHECK (request_hash IS NULL OR octet_length(request_hash) = 32);

ALTER TABLE waitlist_entries
  ADD COLUMN accepted_at timestamptz;
