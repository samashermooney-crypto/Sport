CREATE INDEX report_delivery_recipients_account_idx
  ON report_delivery_recipients(account_id);
CREATE INDEX fundraising_campaigns_team_season_fk_idx
  ON fundraising_campaigns(org_id, team_season_id)
  WHERE team_season_id IS NOT NULL;
CREATE INDEX website_settings_home_page_fk_idx
  ON website_settings(org_id, home_page_id)
  WHERE home_page_id IS NOT NULL;
CREATE INDEX website_revisions_created_by_fk_idx
  ON website_revisions(created_by)
  WHERE created_by IS NOT NULL;
CREATE INDEX news_posts_author_account_fk_idx
  ON news_posts(author_account_id)
  WHERE author_account_id IS NOT NULL;
CREATE INDEX sponsors_invoice_fk_idx
  ON sponsors(org_id, invoice_id)
  WHERE invoice_id IS NOT NULL;
CREATE INDEX donations_donor_account_fk_idx
  ON donations(donor_account_id)
  WHERE donor_account_id IS NOT NULL;
CREATE INDEX donations_payment_fk_idx
  ON donations(org_id, payment_id)
  WHERE payment_id IS NOT NULL;
CREATE INDEX saved_reports_created_by_fk_idx
  ON saved_reports(created_by);
CREATE INDEX report_schedules_created_by_fk_idx
  ON report_schedules(created_by);
CREATE INDEX report_schedules_saved_report_fk_idx
  ON report_schedules(org_id, saved_report_id);
CREATE INDEX org_data_exports_requested_by_fk_idx
  ON org_data_exports(requested_by);
CREATE INDEX org_privacy_requests_requested_by_fk_idx
  ON org_privacy_requests(requested_by);
CREATE INDEX org_privacy_requests_completed_by_fk_idx
  ON org_privacy_requests(completed_by)
  WHERE completed_by IS NOT NULL;

ALTER TABLE retention_sweep_runs
  ALTER COLUMN org_id SET NOT NULL;
