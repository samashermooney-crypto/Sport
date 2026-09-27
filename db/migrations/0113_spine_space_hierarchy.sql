CREATE FUNCTION validate_space_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_space_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM spaces parent
    WHERE parent.org_id = NEW.org_id
      AND parent.id = NEW.parent_space_id
      AND parent.facility_id = NEW.facility_id
  ) THEN
    RAISE EXCEPTION 'A child space must share its parent facility';
  END IF;
  IF EXISTS (
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_space_id, ARRAY[id] AS path
      FROM spaces WHERE org_id = NEW.org_id AND id = NEW.parent_space_id
      UNION ALL
      SELECT parent.id, parent.parent_space_id, ancestors.path || parent.id
      FROM spaces parent JOIN ancestors ON parent.id = ancestors.parent_space_id
      WHERE parent.org_id = NEW.org_id AND NOT parent.id = ANY(ancestors.path)
    )
    SELECT 1 FROM ancestors WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'Space hierarchy cannot contain a cycle';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spaces_validate_parent BEFORE INSERT OR UPDATE OF parent_space_id, facility_id ON spaces
  FOR EACH ROW EXECUTE FUNCTION validate_space_parent();
