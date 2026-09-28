CREATE FUNCTION protect_published_program_slug() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.slug <> NEW.slug AND OLD.status NOT IN ('draft', 'archived') THEN
    RAISE EXCEPTION 'Unpublish the program before changing its URL';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER programs_protect_published_slug BEFORE UPDATE OF slug ON programs
  FOR EACH ROW EXECUTE FUNCTION protect_published_program_slug();

CREATE FUNCTION create_default_division() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO divisions (id, org_id, program_id, name, code, is_default)
  VALUES (gen_random_uuid(), NEW.org_id, NEW.id, 'All participants', 'ALL', true);
  RETURN NEW;
END;
$$;
CREATE TRIGGER programs_create_default_division AFTER INSERT ON programs
  FOR EACH ROW EXECUTE FUNCTION create_default_division();

INSERT INTO divisions (id, org_id, program_id, name, code, is_default)
SELECT gen_random_uuid(), p.org_id, p.id, 'All participants', 'ALL', true
FROM programs p WHERE NOT EXISTS (
  SELECT 1 FROM divisions d WHERE d.org_id = p.org_id AND d.program_id = p.id AND d.is_default
);
