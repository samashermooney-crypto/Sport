ALTER TABLE gl_codes
  ADD COLUMN creation_key uuid,
  ADD COLUMN creation_hash text;

ALTER TABLE gl_codes
  ADD CONSTRAINT gl_codes_creation_pair_check
    CHECK ((creation_key IS NULL) = (creation_hash IS NULL));

CREATE UNIQUE INDEX gl_codes_creation_key_idx
  ON gl_codes(org_id, creation_key) WHERE creation_key IS NOT NULL;
