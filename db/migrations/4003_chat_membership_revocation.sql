ALTER TABLE conversation_members
  ADD COLUMN revoked_at timestamptz;

CREATE INDEX conversation_members_active_conversation_idx
  ON conversation_members(org_id, conversation_id, account_id)
  WHERE revoked_at IS NULL;
