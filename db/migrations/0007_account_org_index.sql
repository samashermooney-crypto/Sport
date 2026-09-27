ALTER TABLE accounts ADD COLUMN linked_org_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

CREATE FUNCTION index_account_organization() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE accounts
  SET linked_org_ids = array_append(linked_org_ids, NEW.org_id)
  WHERE id = NEW.account_id AND NOT NEW.org_id = ANY(linked_org_ids);
  RETURN NEW;
END;
$$;

CREATE TRIGGER org_memberships_index_account
AFTER INSERT ON org_memberships
FOR EACH ROW EXECUTE FUNCTION index_account_organization();
