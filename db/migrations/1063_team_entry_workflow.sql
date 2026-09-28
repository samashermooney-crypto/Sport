-- Durable idempotency for external team entry creation and checkout binding
-- for invited players completing the normal registration requirements.
ALTER TABLE team_entries
  ADD COLUMN creation_key uuid,
  ADD COLUMN creation_hash bytea,
  ADD CONSTRAINT team_entry_creation_hash_length
    CHECK (creation_hash IS NULL OR octet_length(creation_hash) = 32),
  ADD CONSTRAINT team_entry_creation_key_hash_pair
    CHECK ((creation_key IS NULL) = (creation_hash IS NULL));

CREATE UNIQUE INDEX team_entry_creation_key_idx
  ON team_entries (org_id, creation_key)
  WHERE creation_key IS NOT NULL;

ALTER TABLE team_entry_invites ADD COLUMN checkout_id uuid;
ALTER TABLE team_entry_invites
  ADD CONSTRAINT team_entry_invites_checkout_fk
    FOREIGN KEY (org_id, checkout_id) REFERENCES checkouts(org_id, id);
CREATE INDEX team_entry_invites_checkout_idx
  ON team_entry_invites(org_id, checkout_id) WHERE checkout_id IS NOT NULL;
