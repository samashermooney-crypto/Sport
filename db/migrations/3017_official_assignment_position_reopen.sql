DROP INDEX official_assignments_active_position_idx;
CREATE UNIQUE INDEX official_assignments_active_position_idx ON official_assignments(org_id, contest_id, position_key) WHERE status IN ('offered', 'accepted', 'confirmed');
