ALTER TABLE plans ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);
