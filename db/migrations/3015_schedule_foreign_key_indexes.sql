CREATE INDEX IF NOT EXISTS facilities_layout_file_lookup_idx
  ON facilities (org_id, layout_image_file_id);
CREATE INDEX IF NOT EXISTS schedule_change_batches_recipient_account_idx
  ON schedule_change_batches (recipient_account_id);
CREATE INDEX IF NOT EXISTS schedule_change_batches_created_by_idx
  ON schedule_change_batches (created_by);
CREATE INDEX IF NOT EXISTS schedule_change_batches_notification_lookup_idx
  ON schedule_change_batches (org_id, notification_id);
CREATE INDEX IF NOT EXISTS tournament_entries_checked_in_by_idx
  ON tournament_entries (checked_in_by);
CREATE INDEX IF NOT EXISTS contests_disputed_by_idx
  ON contests (disputed_by);
CREATE INDEX IF NOT EXISTS season_survey_campaigns_created_by_idx
  ON season_survey_campaigns (created_by);
CREATE INDEX IF NOT EXISTS season_survey_responses_respondent_account_idx
  ON season_survey_responses (respondent_account_id);
CREATE INDEX IF NOT EXISTS coach_player_ratings_coach_account_idx
  ON coach_player_ratings (coach_account_id);
CREATE INDEX IF NOT EXISTS coach_player_ratings_person_lookup_idx
  ON coach_player_ratings (org_id, person_id);
CREATE INDEX IF NOT EXISTS season_awards_issued_by_idx
  ON season_awards (issued_by);
CREATE INDEX IF NOT EXISTS season_awards_person_lookup_idx
  ON season_awards (org_id, person_id);
CREATE INDEX IF NOT EXISTS season_awards_team_lookup_idx
  ON season_awards (org_id, team_season_id);
CREATE INDEX IF NOT EXISTS season_awards_certificate_lookup_idx
  ON season_awards (org_id, certificate_file_id);
CREATE INDEX IF NOT EXISTS tournament_entries_team_lookup_idx
  ON tournament_entries (org_id, team_season_id);
CREATE INDEX IF NOT EXISTS tournament_entries_external_team_lookup_idx
  ON tournament_entries (org_id, external_team_id);
CREATE INDEX IF NOT EXISTS official_pay_batches_approved_by_idx
  ON official_pay_batches (approved_by);
CREATE INDEX IF NOT EXISTS official_pay_batches_paid_by_idx
  ON official_pay_batches (paid_by);
CREATE INDEX IF NOT EXISTS allocation_requests_requested_by_idx
  ON allocation_requests (requested_by);
CREATE INDEX IF NOT EXISTS allocation_requests_decided_by_idx
  ON allocation_requests (decided_by);
CREATE INDEX IF NOT EXISTS allocation_requests_resulting_event_lookup_idx
  ON allocation_requests (org_id, resulting_event_id);
CREATE INDEX IF NOT EXISTS sport_profile_versions_created_by_idx
  ON sport_profile_versions (created_by);
CREATE INDEX IF NOT EXISTS schedule_blackout_requests_requested_by_idx
  ON schedule_blackout_requests (requested_by);
CREATE INDEX IF NOT EXISTS schedule_blackout_requests_decided_by_idx
  ON schedule_blackout_requests (decided_by);
CREATE INDEX IF NOT EXISTS contests_profile_version_lookup_idx
  ON contests (org_id, sport_profile_id, profile_version);
CREATE INDEX IF NOT EXISTS schedule_import_runs_created_by_idx
  ON schedule_import_runs (created_by);
CREATE INDEX IF NOT EXISTS schedule_import_runs_creator_lookup_idx
  ON schedule_import_runs (org_id, created_by);
