-- Track I: creation keys make enrollment, booking, punch-card and
-- subscription writes replay-safe under the Idempotency-Key convention.

ALTER TABLE class_enrollments ADD COLUMN creation_key uuid;
ALTER TABLE class_session_bookings ADD COLUMN creation_key uuid;
ALTER TABLE punch_cards ADD COLUMN creation_key uuid;
ALTER TABLE tuition_subscriptions ADD COLUMN creation_key uuid;

CREATE UNIQUE INDEX class_enrollments_creation_key_idx
  ON class_enrollments(org_id, creation_key) WHERE creation_key IS NOT NULL;
CREATE UNIQUE INDEX class_session_bookings_creation_key_idx
  ON class_session_bookings(org_id, creation_key) WHERE creation_key IS NOT NULL;
CREATE UNIQUE INDEX punch_cards_creation_key_idx
  ON punch_cards(org_id, creation_key) WHERE creation_key IS NOT NULL;
CREATE UNIQUE INDEX tuition_subscriptions_creation_key_idx
  ON tuition_subscriptions(org_id, creation_key) WHERE creation_key IS NOT NULL;
