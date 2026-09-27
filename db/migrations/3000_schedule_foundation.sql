-- Track G: use the binding structured recurrence schema in place of RFC text.
CREATE FUNCTION schedule_recurrence_from_rrule(
  source_rule text,
  first_date date,
  last_date date
) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  normalized text := upper(regexp_replace(trim(source_rule), '^RRULE:', ''));
  frequency text := substring(upper(regexp_replace(trim(source_rule), '^RRULE:', '')) FROM 'FREQ=([A-Z]+)');
  day_text text;
  day_codes text[];
  weekday_parts text[];
  interval_value integer;
  count_value integer;
  nth_value integer;
  result jsonb;
BEGIN
  IF first_date IS NULL THEN
    RAISE EXCEPTION 'Recurring availability needs a start date';
  END IF;
  IF frequency = 'WEEKLY' THEN
    interval_value := COALESCE(substring(normalized FROM 'INTERVAL=([0-9]+)')::integer, 1);
    IF interval_value NOT BETWEEN 1 AND 4 THEN
      RAISE EXCEPTION 'Unsupported weekly recurrence interval: %', interval_value;
    END IF;
    day_text := substring(normalized FROM 'BYDAY=([^;]+)');
    IF day_text IS NULL THEN
      day_codes := ARRAY[(ARRAY['MO','TU','WE','TH','FR','SA','SU'])[extract(isodow FROM first_date)::integer]];
    ELSE
      day_codes := string_to_array(day_text, ',');
    END IF;
    IF cardinality(day_codes) = 0 OR EXISTS (
      SELECT 1 FROM unnest(day_codes) AS d(code)
      WHERE d.code NOT IN ('MO','TU','WE','TH','FR','SA','SU')
    ) THEN
      RAISE EXCEPTION 'Unsupported weekly BYDAY value: %', day_text;
    END IF;
    result := jsonb_build_object(
      'kind', 'weekly',
      'interval', interval_value,
      'byDay', to_jsonb(day_codes),
      'startsOn', first_date::text,
      'endsOn', last_date::text,
      'exceptions', '[]'::jsonb,
      'additions', '[]'::jsonb
    );
    count_value := substring(normalized FROM 'COUNT=([0-9]+)')::integer;
    IF count_value IS NOT NULL THEN result := result || jsonb_build_object('count', count_value); END IF;
    RETURN result;
  ELSIF frequency = 'MONTHLY' THEN
    weekday_parts := regexp_match(normalized, 'BYDAY=(-1|[1-4])(MO|TU|WE|TH|FR|SA|SU)');
    IF weekday_parts IS NULL THEN
      RAISE EXCEPTION 'Unsupported monthly recurrence rule: %', source_rule;
    END IF;
    nth_value := weekday_parts[1]::integer;
    RETURN jsonb_build_object(
      'kind', 'monthly_nth_weekday',
      'nth', nth_value,
      'weekday', weekday_parts[2],
      'startsOn', first_date::text,
      'endsOn', last_date::text,
      'exceptions', '[]'::jsonb
    );
  END IF;
  RAISE EXCEPTION 'Unsupported recurrence rule in scheduling data: %', source_rule;
END;
$$;

ALTER TABLE space_availability ADD COLUMN recurrence jsonb;
UPDATE space_availability
SET recurrence = schedule_recurrence_from_rrule(rrule, starts_on, ends_on);
ALTER TABLE space_availability ALTER COLUMN recurrence SET NOT NULL;
ALTER TABLE space_availability DROP COLUMN rrule;

ALTER TABLE allocations ADD COLUMN recurrence jsonb;
UPDATE allocations
SET recurrence = schedule_recurrence_from_rrule(rrule, starts_on, ends_on);
ALTER TABLE allocations ALTER COLUMN recurrence SET NOT NULL;
ALTER TABLE allocations DROP COLUMN rrule;

ALTER TABLE official_availability ADD COLUMN recurrence jsonb;
UPDATE official_availability
SET recurrence = schedule_recurrence_from_rrule(rrule, starts_on, ends_on)
WHERE rrule IS NOT NULL;
ALTER TABLE official_availability DROP CONSTRAINT official_availability_check;
ALTER TABLE official_availability DROP COLUMN rrule;
ALTER TABLE official_availability ADD CONSTRAINT official_availability_schedule_window_check
  CHECK (recurrence IS NOT NULL OR (starts_on IS NOT NULL AND ends_on IS NOT NULL));
DROP FUNCTION schedule_recurrence_from_rrule(text, date, date);

ALTER TABLE facilities ADD COLUMN layout_image_file_id uuid;
ALTER TABLE facilities ADD CONSTRAINT facilities_layout_file_fk
  FOREIGN KEY (org_id, layout_image_file_id) REFERENCES files(org_id, id);

ALTER TABLE schedule_generation_runs
  ADD COLUMN progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  ADD COLUMN progress_message text,
  ADD COLUMN error_code text;

CREATE TABLE schedule_change_batches (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  recipient_account_id uuid NOT NULL REFERENCES accounts(id),
  created_by uuid NOT NULL REFERENCES accounts(id),
  changes jsonb NOT NULL CHECK (jsonb_typeof(changes) = 'array'),
  emit_after timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'emitted', 'canceled')),
  notification_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, notification_id) REFERENCES notifications(org_id, id)
);
CREATE UNIQUE INDEX schedule_change_batches_pending_account_idx
  ON schedule_change_batches(org_id, recipient_account_id)
  WHERE status = 'pending';
CREATE INDEX schedule_change_batches_due_idx
  ON schedule_change_batches(org_id, emit_after)
  WHERE status = 'pending';
SELECT configure_spine_tenant_table('schedule_change_batches');

CREATE TABLE schedule_settings (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  program_id uuid NOT NULL,
  coach_slot_picker_enabled boolean NOT NULL DEFAULT false,
  slot_approval_required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (org_id, id),
  UNIQUE (org_id, program_id),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id)
);
SELECT configure_spine_tenant_table('schedule_settings');
