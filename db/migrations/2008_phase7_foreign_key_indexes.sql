CREATE INDEX compliance_overrides_approved_by_idx
  ON compliance_overrides(approved_by);
CREATE INDEX compliance_overrides_revoked_by_idx
  ON compliance_overrides(revoked_by)
  WHERE revoked_by IS NOT NULL;
CREATE INDEX compliance_overrides_scope_idx
  ON compliance_overrides(org_id, scope_id)
  WHERE scope_id IS NOT NULL;

CREATE INDEX person_credentials_file_idx
  ON person_credentials(org_id, file_id)
  WHERE file_id IS NOT NULL;
CREATE INDEX return_to_play_clearances_reviewed_by_idx
  ON return_to_play_clearances(reviewed_by)
  WHERE reviewed_by IS NOT NULL;
CREATE INDEX return_to_play_clearances_file_idx
  ON return_to_play_clearances(org_id, clearance_file_id);
CREATE INDEX athlete_cards_photo_file_idx
  ON athlete_cards(org_id, photo_file_id)
  WHERE photo_file_id IS NOT NULL;

CREATE INDEX background_check_adjudication_events_actor_idx
  ON background_check_adjudication_events(actor_account_id);
CREATE INDEX background_check_disputes_candidate_idx
  ON background_check_disputes(candidate_account_id);
CREATE INDEX background_check_disputes_resolved_by_idx
  ON background_check_disputes(resolved_by)
  WHERE resolved_by IS NOT NULL;
