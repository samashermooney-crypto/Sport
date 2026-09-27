-- Account org IDs are candidate scopes only. Family reads recheck the active,
-- verified person link inside withOrg before disclosing any person data.
CREATE TRIGGER person_account_links_index_account
AFTER INSERT ON person_account_links
FOR EACH ROW EXECUTE FUNCTION index_account_organization();

UPDATE accounts AS account
SET linked_org_ids = (
  SELECT ARRAY(
    SELECT DISTINCT org_id
    FROM (
      SELECT membership.org_id FROM org_memberships AS membership
      WHERE membership.account_id = account.id
      UNION
      SELECT link.org_id FROM person_account_links AS link
      WHERE link.account_id = account.id
    ) AS scopes
    ORDER BY org_id
  )
)
WHERE EXISTS (
  SELECT 1 FROM person_account_links AS link
  WHERE link.account_id = account.id
);
