ALTER TABLE evaluation_sessions ADD COLUMN calendar_event_id uuid;

INSERT INTO events (
  id, org_id, program_id, kind, title, starts_at, ends_at, timezone,
  location_text, status, published, arrival_minutes_before
)
SELECT
  session.id, session.org_id, evaluation.tryout_program_id, 'evaluation_session',
  session.name, session.starts_at, session.ends_at, session.timezone,
  facility.name, 'scheduled', false, 0
FROM evaluation_sessions session
JOIN evaluation_events evaluation
  ON evaluation.org_id = session.org_id AND evaluation.id = session.evaluation_event_id
LEFT JOIN facilities facility
  ON facility.org_id = session.org_id AND facility.id = session.facility_id;

UPDATE evaluation_sessions SET calendar_event_id = id;

ALTER TABLE evaluation_sessions ALTER COLUMN calendar_event_id SET NOT NULL;
ALTER TABLE evaluation_sessions
  ADD CONSTRAINT evaluation_sessions_calendar_event_fk
  FOREIGN KEY (org_id, calendar_event_id) REFERENCES events(org_id, id);
CREATE UNIQUE INDEX evaluation_sessions_calendar_event_idx
  ON evaluation_sessions(org_id, calendar_event_id);
