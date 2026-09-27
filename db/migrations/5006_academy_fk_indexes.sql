CREATE INDEX athlete_skill_records_assessed_by_idx
  ON athlete_skill_records(assessed_by);
CREATE INDEX class_enrollments_account_id_idx
  ON class_enrollments(account_id);
CREATE INDEX class_instructors_added_by_idx
  ON class_instructors(added_by);
CREATE INDEX class_session_bookings_account_id_idx
  ON class_session_bookings(account_id);
CREATE INDEX class_session_bookings_credit_idx
  ON class_session_bookings(org_id, makeup_credit_id);
CREATE INDEX class_session_bookings_household_idx
  ON class_session_bookings(org_id, household_id);
CREATE INDEX class_session_bookings_invoice_idx
  ON class_session_bookings(org_id, invoice_id);
CREATE INDEX class_session_bookings_punch_card_idx
  ON class_session_bookings(org_id, punch_card_id);
CREATE INDEX class_sessions_substitute_person_idx
  ON class_sessions(org_id, substitute_person_id);
CREATE INDEX class_waitlist_entries_account_id_idx
  ON class_waitlist_entries(account_id);
CREATE INDEX class_waitlist_entries_enrollment_idx
  ON class_waitlist_entries(org_id, enrollment_id);
CREATE INDEX class_waitlist_entries_household_idx
  ON class_waitlist_entries(org_id, household_id);
CREATE INDEX class_waitlist_entries_person_idx
  ON class_waitlist_entries(org_id, person_id);
CREATE INDEX level_promotions_decided_by_idx
  ON level_promotions(decided_by_account_id);
CREATE INDEX level_promotions_from_level_idx
  ON level_promotions(org_id, from_level_id);
CREATE INDEX level_promotions_source_enrollment_idx
  ON level_promotions(org_id, source_enrollment_id);
CREATE INDEX level_promotions_target_enrollment_idx
  ON level_promotions(org_id, target_enrollment_id);
CREATE INDEX level_promotions_to_level_idx
  ON level_promotions(org_id, to_level_id);
CREATE INDEX level_promotions_recommended_by_idx
  ON level_promotions(recommended_by);
CREATE INDEX makeup_credits_offering_idx
  ON makeup_credits(org_id, class_offering_id);
CREATE INDEX makeup_credits_source_event_idx
  ON makeup_credits(org_id, source_event_id);
CREATE INDEX makeup_credits_used_event_idx
  ON makeup_credits(org_id, used_event_id);
CREATE INDEX punch_cards_account_id_idx
  ON punch_cards(account_id);
CREATE INDEX punch_cards_household_idx
  ON punch_cards(org_id, household_id);
CREATE INDEX punch_cards_invoice_idx
  ON punch_cards(org_id, invoice_id);
CREATE INDEX tuition_invoices_invoice_idx
  ON tuition_invoices(org_id, invoice_id);
CREATE INDEX tuition_subscriptions_payment_method_idx
  ON tuition_subscriptions(payment_method_id);
