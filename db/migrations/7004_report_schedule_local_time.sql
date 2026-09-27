-- Preserve schedule wall-clock time and cadence anchors in the organization's
-- current timezone; next_run_at remains the UTC instant used by the worker.
ALTER TABLE report_schedules
  ADD COLUMN run_at_minute smallint NOT NULL DEFAULT 360
    CHECK (run_at_minute BETWEEN 0 AND 1439),
  ADD COLUMN run_on_weekday smallint,
  ADD COLUMN run_on_day smallint;

UPDATE report_schedules s
SET run_on_weekday = extract(isodow FROM (s.next_run_at AT TIME ZONE o.timezone))::smallint
FROM organizations o
WHERE o.id = s.org_id AND s.cadence = 'weekly';

UPDATE report_schedules s
SET run_on_day = extract(day FROM (s.next_run_at AT TIME ZONE o.timezone))::smallint
FROM organizations o
WHERE o.id = s.org_id AND s.cadence = 'monthly';

ALTER TABLE report_schedules
  ADD CONSTRAINT report_schedules_weekday_check
    CHECK (run_on_weekday IS NULL OR run_on_weekday BETWEEN 1 AND 7),
  ADD CONSTRAINT report_schedules_day_check
    CHECK (run_on_day IS NULL OR run_on_day BETWEEN 1 AND 31),
  ADD CONSTRAINT report_schedules_weekly_anchor_check
    CHECK (cadence <> 'weekly' OR run_on_weekday IS NOT NULL),
  ADD CONSTRAINT report_schedules_monthly_anchor_check
    CHECK (cadence <> 'monthly' OR run_on_day IS NOT NULL);
