ALTER TABLE level_promotions
  ADD COLUMN target_class_offering_id uuid;
ALTER TABLE level_promotions
  ADD CONSTRAINT level_promotions_target_offering_fk
  FOREIGN KEY (org_id, target_class_offering_id)
  REFERENCES class_offerings(org_id, id);
CREATE INDEX level_promotions_target_offering_idx
  ON level_promotions(org_id, target_class_offering_id)
  WHERE target_class_offering_id IS NOT NULL;
