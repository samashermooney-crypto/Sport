CREATE TABLE files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (purpose IN ('image','document','import','website_asset')),
  owner_type text,
  owner_id uuid,
  storage_key text NOT NULL UNIQUE,
  mime text NOT NULL,
  bytes bigint NOT NULL CHECK (bytes > 0),
  sha256 text,
  width integer,
  height integer,
  sensitivity text NOT NULL DEFAULT 'internal' CHECK (sensitivity IN ('public','internal','sensitive','restricted')),
  created_by uuid NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  upload_state text NOT NULL DEFAULT 'pending' CHECK (upload_state IN ('pending','complete','rejected')),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '1 hour',
  UNIQUE (org_id, id)
);
CREATE INDEX files_org_owner_idx ON files(org_id, owner_type, owner_id) WHERE deleted_at IS NULL;
CREATE TRIGGER files_set_updated_at BEFORE UPDATE ON files FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE files ENABLE ROW LEVEL SECURITY;
ALTER TABLE files FORCE ROW LEVEL SECURITY;
CREATE POLICY files_org_isolation ON files
  USING (org_id IS NULL OR org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id IS NULL OR org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
