-- Files in this application are tenant-owned; public website assets remain org-owned
-- and become public only through the publish flow's separate public storage prefix.
ALTER TABLE files ALTER COLUMN org_id SET NOT NULL;
DROP POLICY files_org_isolation ON files;
CREATE POLICY files_org_isolation ON files TO athlentry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
