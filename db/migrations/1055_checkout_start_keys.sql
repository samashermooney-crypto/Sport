ALTER TABLE checkouts
  ADD COLUMN creation_key uuid,
  ADD COLUMN creation_hash text;

ALTER TABLE checkouts
  ADD CONSTRAINT checkouts_creation_pair_check
    CHECK ((creation_key IS NULL) = (creation_hash IS NULL));

CREATE UNIQUE INDEX checkouts_account_creation_key_idx
  ON checkouts(org_id, account_id, creation_key)
  WHERE creation_key IS NOT NULL;
