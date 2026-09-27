CREATE INDEX import_batches_created_by_idx
  ON import_batches (created_by);
CREATE INDEX import_batches_committed_by_idx
  ON import_batches (committed_by)
  WHERE committed_by IS NOT NULL;
CREATE INDEX import_batches_rolled_back_by_idx
  ON import_batches (rolled_back_by)
  WHERE rolled_back_by IS NOT NULL;
CREATE INDEX import_mapping_presets_created_by_idx
  ON import_mapping_presets (created_by);
CREATE INDEX import_rows_target_person_idx
  ON import_rows (org_id, target_person_id)
  WHERE target_person_id IS NOT NULL;
