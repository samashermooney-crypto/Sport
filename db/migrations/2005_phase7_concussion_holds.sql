CREATE OR REPLACE FUNCTION block_roster_on_concussion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_suspected_concussion AND NEW.status IN ('open', 'return_to_play_pending') THEN
    INSERT INTO injury_roster_holds (id, org_id, injury_report_id, roster_entry_id, former_status)
    SELECT gen_random_uuid(), NEW.org_id, NEW.id, roster.id, roster.status
    FROM roster_entries AS roster
    WHERE roster.org_id = NEW.org_id
      AND roster.person_id = NEW.person_id
      AND roster.status = 'active'
    ON CONFLICT (org_id, injury_report_id, roster_entry_id) DO NOTHING;
    UPDATE roster_entries SET status = 'injured', version = version + 1
    WHERE org_id = NEW.org_id AND person_id = NEW.person_id AND status = 'active';
  END IF;
  IF NEW.status = 'cleared' AND OLD.status IS DISTINCT FROM 'cleared'
    AND NOT EXISTS (
      SELECT 1 FROM injury_reports AS other
      WHERE other.org_id = NEW.org_id
        AND other.person_id = NEW.person_id
        AND other.id <> NEW.id
        AND other.is_suspected_concussion
        AND other.status IN ('open', 'return_to_play_pending')
    ) THEN
    UPDATE roster_entries AS roster
    SET status = holds.former_status, version = roster.version + 1
    FROM injury_roster_holds AS holds
    WHERE holds.org_id = NEW.org_id
      AND holds.roster_entry_id = roster.id
      AND roster.org_id = NEW.org_id
      AND roster.person_id = NEW.person_id
      AND holds.restored_at IS NULL
      AND roster.status = 'injured';
    UPDATE injury_roster_holds AS holds
    SET restored_at = now(), version = version + 1
    FROM roster_entries AS roster
    WHERE holds.org_id = NEW.org_id
      AND holds.roster_entry_id = roster.id
      AND roster.org_id = NEW.org_id
      AND roster.person_id = NEW.person_id
      AND holds.restored_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;
