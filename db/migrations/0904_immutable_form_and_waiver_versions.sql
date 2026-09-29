CREATE FUNCTION protect_published_form_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL AND (
    NEW.id IS DISTINCT FROM OLD.id OR
    NEW.org_id IS DISTINCT FROM OLD.org_id OR
    NEW.scope IS DISTINCT FROM OLD.scope OR
    NEW.owner_type IS DISTINCT FROM OLD.owner_type OR
    NEW.owner_id IS DISTINCT FROM OLD.owner_id OR
    NEW.name IS DISTINCT FROM OLD.name OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.schema IS DISTINCT FROM OLD.schema OR
    NEW.published_at IS DISTINCT FROM OLD.published_at OR
    NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
  ) THEN
    RAISE EXCEPTION 'published form versions are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER form_definitions_protect_published
  BEFORE UPDATE ON form_definitions
  FOR EACH ROW EXECUTE FUNCTION protect_published_form_version();

CREATE FUNCTION protect_published_waiver_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.published_at IS NOT NULL AND (
    NEW.id IS DISTINCT FROM OLD.id OR
    NEW.org_id IS DISTINCT FROM OLD.org_id OR
    NEW.name IS DISTINCT FROM OLD.name OR
    NEW.body_html IS DISTINCT FROM OLD.body_html OR
    NEW.version IS DISTINCT FROM OLD.version OR
    NEW.requires IS DISTINCT FROM OLD.requires OR
    NEW.renewal IS DISTINCT FROM OLD.renewal OR
    NEW.template_unreviewed IS DISTINCT FROM OLD.template_unreviewed OR
    NEW.published_at IS DISTINCT FROM OLD.published_at OR
    NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
  ) THEN
    RAISE EXCEPTION 'published waiver versions are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER waiver_documents_protect_published
  BEFORE UPDATE ON waiver_documents
  FOR EACH ROW EXECUTE FUNCTION protect_published_waiver_version();

CREATE FUNCTION prevent_waiver_signature_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'waiver signatures are append-only'
    USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER waiver_signatures_append_only
  BEFORE UPDATE OR DELETE ON waiver_signatures
  FOR EACH ROW EXECUTE FUNCTION prevent_waiver_signature_mutation();
