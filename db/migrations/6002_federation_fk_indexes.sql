-- Keep federation foreign-key lookups indexed, as required by the spine
-- schema contract and to avoid table scans on relationship cleanup/joins.

CREATE INDEX org_relationships_pending_sharing_by_idx
  ON org_relationships(pending_sharing_by);
CREATE INDEX org_relationships_initiated_by_account_idx
  ON org_relationships(initiated_by_account_id);
CREATE INDEX org_relationships_suspended_by_account_idx
  ON org_relationships(suspended_by_account_id);
CREATE INDEX org_relationships_ended_by_account_idx
  ON org_relationships(ended_by_account_id);

CREATE INDEX federation_roster_windows_created_by_idx
  ON federation_roster_windows(created_by);
CREATE INDEX federation_roster_snapshots_member_org_idx
  ON federation_roster_snapshots(member_org_id);
CREATE INDEX federation_roster_snapshots_submitted_by_idx
  ON federation_roster_snapshots(submitted_by);

CREATE INDEX federation_space_contributions_space_idx
  ON federation_space_contributions(org_id, space_id);
CREATE INDEX federation_space_contributions_created_by_idx
  ON federation_space_contributions(created_by);

CREATE INDEX federation_event_links_relationship_idx
  ON federation_event_links(relationship_id);
CREATE INDEX federation_event_links_club_event_idx
  ON federation_event_links(club_event_id);

CREATE INDEX federation_discipline_member_org_idx
  ON federation_discipline_records(member_org_id);
CREATE INDEX federation_discipline_issued_by_idx
  ON federation_discipline_records(issued_by);
CREATE INDEX federation_discipline_external_team_idx
  ON federation_discipline_records(org_id, external_team_id);

CREATE INDEX federation_member_payers_member_org_idx
  ON federation_member_payers(member_org_id);
CREATE INDEX federation_member_payers_billing_account_idx
  ON federation_member_payers(billing_account_id);
CREATE INDEX federation_member_payers_created_by_idx
  ON federation_member_payers(created_by);

CREATE INDEX federation_fee_assessments_member_org_idx
  ON federation_fee_assessments(member_org_id);
CREATE INDEX federation_fee_assessments_created_by_idx
  ON federation_fee_assessments(created_by);
CREATE INDEX federation_fee_assessments_team_entry_idx
  ON federation_fee_assessments(org_id, team_entry_id);
CREATE INDEX federation_fee_assessments_invoice_idx
  ON federation_fee_assessments(org_id, invoice_id);
