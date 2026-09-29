-- Public host routing must map only a verified custom hostname supplied by
-- this request. The app role receives no general cross-organization read.
CREATE POLICY site_domains_public_host_lookup
  ON site_domains
  FOR SELECT
  TO athlentry_app
  USING (
    host = NULLIF(current_setting('app.public_site_host', true), '')
    AND kind = 'custom'
    AND status = 'active'
    AND verified_at IS NOT NULL
  );
