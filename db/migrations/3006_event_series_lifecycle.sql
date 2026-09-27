ALTER TABLE event_series
  ADD COLUMN active boolean NOT NULL DEFAULT true;

CREATE INDEX event_series_active_org_idx
  ON event_series(org_id, created_at DESC)
  WHERE active;
