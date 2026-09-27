ALTER TABLE org_memberships
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
