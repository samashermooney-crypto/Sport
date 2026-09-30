-- Every program, division and registration offering owns a capacity counter.
-- Checkout holds lock the program, division and offering counters together, so a
-- missing counter blocks family registration. Counters are created with the
-- subject and follow division player-capacity changes.

CREATE FUNCTION create_program_capacity_counter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO capacity_counters (id, org_id, subject_type, subject_id, capacity)
  VALUES (gen_random_uuid(), NEW.org_id, 'program', NEW.id, NULL)
  ON CONFLICT (org_id, subject_type, subject_id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER programs_create_capacity_counter AFTER INSERT ON programs
  FOR EACH ROW EXECUTE FUNCTION create_program_capacity_counter();

CREATE FUNCTION create_division_capacity_counter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO capacity_counters (id, org_id, subject_type, subject_id, capacity)
  VALUES (gen_random_uuid(), NEW.org_id, 'division', NEW.id, NEW.capacity_players)
  ON CONFLICT (org_id, subject_type, subject_id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER divisions_create_capacity_counter AFTER INSERT ON divisions
  FOR EACH ROW EXECUTE FUNCTION create_division_capacity_counter();

CREATE FUNCTION sync_division_capacity_counter() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  used integer;
BEGIN
  SELECT confirmed + held INTO used FROM capacity_counters
  WHERE org_id = NEW.org_id AND subject_type = 'division' AND subject_id = NEW.id
  FOR UPDATE;
  IF NEW.capacity_players IS NOT NULL AND used IS NOT NULL AND NEW.capacity_players < used THEN
    RAISE EXCEPTION 'Capacity cannot fall below confirmed and held places';
  END IF;
  UPDATE capacity_counters
  SET capacity = NEW.capacity_players, version = version + 1
  WHERE org_id = NEW.org_id AND subject_type = 'division' AND subject_id = NEW.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER divisions_sync_capacity_counter
  AFTER UPDATE OF capacity_players ON divisions
  FOR EACH ROW WHEN (OLD.capacity_players IS DISTINCT FROM NEW.capacity_players)
  EXECUTE FUNCTION sync_division_capacity_counter();

CREATE FUNCTION remove_division_capacity_counter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM capacity_counters
  WHERE org_id = OLD.org_id AND subject_type = 'division' AND subject_id = OLD.id
    AND confirmed = 0 AND held = 0;
  RETURN OLD;
END;
$$;
CREATE TRIGGER divisions_remove_capacity_counter AFTER DELETE ON divisions
  FOR EACH ROW EXECUTE FUNCTION remove_division_capacity_counter();

CREATE FUNCTION create_offering_capacity_counter() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO capacity_counters (id, org_id, subject_type, subject_id, capacity)
  VALUES (gen_random_uuid(), NEW.org_id, 'offering', NEW.id, NEW.capacity)
  ON CONFLICT (org_id, subject_type, subject_id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER registration_offerings_create_capacity_counter
  AFTER INSERT ON registration_offerings
  FOR EACH ROW EXECUTE FUNCTION create_offering_capacity_counter();

-- Backfill counters that predate these triggers. Confirmed registrations already
-- occupy their places, so the new counters start from those counts (bounded by
-- any configured capacity to satisfy the counter check constraint).
INSERT INTO capacity_counters (id, org_id, subject_type, subject_id, capacity, confirmed)
SELECT gen_random_uuid(), p.org_id, 'program', p.id, NULL,
  (SELECT count(*) FROM registrations r
    WHERE r.org_id = p.org_id AND r.program_id = p.id AND r.status = 'confirmed')
FROM programs p
ON CONFLICT (org_id, subject_type, subject_id) DO NOTHING;

INSERT INTO capacity_counters (id, org_id, subject_type, subject_id, capacity, confirmed)
SELECT gen_random_uuid(), d.org_id, 'division', d.id, d.capacity_players,
  LEAST((SELECT count(*) FROM registrations r
    WHERE r.org_id = d.org_id AND r.division_id = d.id AND r.status = 'confirmed'),
    COALESCE(d.capacity_players, 2147483647))
FROM divisions d
ON CONFLICT (org_id, subject_type, subject_id) DO NOTHING;

INSERT INTO capacity_counters (id, org_id, subject_type, subject_id, capacity, confirmed)
SELECT gen_random_uuid(), o.org_id, 'offering', o.id, o.capacity,
  LEAST((SELECT count(*) FROM registrations r
    WHERE r.org_id = o.org_id AND r.offering_id = o.id AND r.status = 'confirmed'),
    COALESCE(o.capacity, 2147483647))
FROM registration_offerings o
ON CONFLICT (org_id, subject_type, subject_id) DO NOTHING;
