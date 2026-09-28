CREATE INDEX IF NOT EXISTS evaluation_sessions_event_fk_idx
  ON evaluation_sessions (org_id, evaluation_event_id);
CREATE INDEX IF NOT EXISTS evaluation_sessions_group_fk_idx
  ON evaluation_sessions (org_id, evaluation_group_id);
CREATE INDEX IF NOT EXISTS evaluation_sessions_facility_fk_idx
  ON evaluation_sessions (org_id, facility_id);
CREATE INDEX IF NOT EXISTS evaluation_events_tryout_program_fk_idx
  ON evaluation_events (org_id, tryout_program_id);

CREATE INDEX IF NOT EXISTS evaluation_participants_checked_in_by_fk_idx
  ON evaluation_participants (checked_in_by);
CREATE INDEX IF NOT EXISTS evaluation_participants_person_fk_idx
  ON evaluation_participants (org_id, person_id);
CREATE INDEX IF NOT EXISTS evaluation_participants_group_fk_idx
  ON evaluation_participants (org_id, evaluation_group_id);
CREATE INDEX IF NOT EXISTS evaluation_participants_registration_fk_idx
  ON evaluation_participants (org_id, registration_id);
CREATE INDEX IF NOT EXISTS evaluation_participants_photo_fk_idx
  ON evaluation_participants (org_id, photo_file_id);

CREATE INDEX IF NOT EXISTS evaluation_session_evaluators_account_fk_idx
  ON evaluation_session_evaluators (account_id);
CREATE INDEX IF NOT EXISTS evaluation_session_evaluators_assigned_by_fk_idx
  ON evaluation_session_evaluators (assigned_by);
CREATE INDEX IF NOT EXISTS evaluation_scores_evaluator_account_fk_idx
  ON evaluation_scores (evaluator_account_id);
CREATE INDEX IF NOT EXISTS evaluation_scores_criterion_fk_idx
  ON evaluation_scores (org_id, evaluation_criterion_id);

CREATE INDEX IF NOT EXISTS placement_boards_event_fk_idx
  ON placement_boards (org_id, evaluation_event_id);
CREATE INDEX IF NOT EXISTS placement_boards_division_fk_idx
  ON placement_boards (org_id, division_id);
CREATE INDEX IF NOT EXISTS team_placements_person_fk_idx
  ON team_placements (org_id, person_id);
CREATE INDEX IF NOT EXISTS team_placements_team_season_fk_idx
  ON team_placements (org_id, team_season_id);
CREATE INDEX IF NOT EXISTS placement_locks_locked_by_fk_idx
  ON placement_locks (locked_by);
CREATE INDEX IF NOT EXISTS placement_locks_person_fk_idx
  ON placement_locks (org_id, person_id);
CREATE INDEX IF NOT EXISTS placement_locks_team_season_fk_idx
  ON placement_locks (org_id, team_season_id);

CREATE INDEX IF NOT EXISTS team_offers_placement_fk_idx
  ON team_offers (org_id, placement_id);
CREATE INDEX IF NOT EXISTS team_offers_person_fk_idx
  ON team_offers (org_id, person_id);
CREATE INDEX IF NOT EXISTS team_offers_offering_fk_idx
  ON team_offers (org_id, offering_id);
CREATE INDEX IF NOT EXISTS team_offers_registration_fk_idx
  ON team_offers (org_id, registration_id);
CREATE INDEX IF NOT EXISTS team_offers_checkout_fk_idx
  ON team_offers (org_id, checkout_id);
CREATE INDEX IF NOT EXISTS team_offers_declined_by_fk_idx
  ON team_offers (declined_by_account_id);

CREATE INDEX IF NOT EXISTS placement_preferences_person_fk_idx
  ON placement_preferences (org_id, person_id);
CREATE INDEX IF NOT EXISTS placement_preferences_friend_request_fk_idx
  ON placement_preferences (org_id, friend_request_person_id);
