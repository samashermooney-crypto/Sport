ALTER TABLE device_tokens ADD COLUMN session_id uuid REFERENCES sessions(id);

UPDATE device_tokens
SET revoked_at = COALESCE(revoked_at, now()),
    token_or_subscription = '{}'::jsonb
WHERE session_id IS NULL;

ALTER TABLE device_tokens
  ADD CONSTRAINT device_tokens_active_session_check
  CHECK (revoked_at IS NOT NULL OR session_id IS NOT NULL);

CREATE INDEX device_tokens_session_active_idx
  ON device_tokens (session_id)
  WHERE revoked_at IS NULL;
