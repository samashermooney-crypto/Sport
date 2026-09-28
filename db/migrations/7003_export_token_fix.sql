-- Fixup: export_download_tokens has no updated_at column, so the
-- set_updated_at trigger would fail on UPDATE. Tokens are immutable and
-- single-use: replace the update path with DELETE on consumption.

DROP TRIGGER export_download_tokens_set_updated_at ON export_download_tokens;
DROP POLICY export_download_tokens_update ON export_download_tokens;
REVOKE UPDATE ON export_download_tokens FROM athlentry_app;

CREATE POLICY export_download_tokens_delete ON export_download_tokens FOR DELETE TO athlentry_app
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
GRANT DELETE ON export_download_tokens TO athlentry_app;
