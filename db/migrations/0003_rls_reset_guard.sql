DROP POLICY org_counters_isolation ON org_counters;
CREATE POLICY org_counters_isolation ON org_counters TO athlentry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY idempotency_keys_isolation ON idempotency_keys;
CREATE POLICY idempotency_keys_isolation ON idempotency_keys TO athlentry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

DROP POLICY audit_log_isolation ON audit_log;
CREATE POLICY audit_log_isolation ON audit_log TO athlentry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
