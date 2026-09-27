ALTER TABLE org_relationships
  ADD COLUMN data_sharing_version integer NOT NULL DEFAULT 0 CHECK (data_sharing_version >= 0),
  ADD COLUMN parent_data_sharing_accepted_version integer NOT NULL DEFAULT 0 CHECK (parent_data_sharing_accepted_version >= 0),
  ADD COLUMN child_data_sharing_accepted_version integer NOT NULL DEFAULT 0 CHECK (child_data_sharing_accepted_version >= 0);
