ALTER TABLE contests ADD COLUMN format_config jsonb;
ALTER TABLE schedule_settings
  ADD COLUMN result_confirmation_required boolean NOT NULL DEFAULT false;
