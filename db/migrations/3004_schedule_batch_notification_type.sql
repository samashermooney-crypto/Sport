ALTER TABLE schedule_change_batches
  ADD COLUMN notification_type text NOT NULL DEFAULT 'schedule.changed'
    CHECK (notification_type IN ('schedule.changed', 'safety.emergency'));
