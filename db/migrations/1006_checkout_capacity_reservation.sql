ALTER TABLE capacity_holds
  ADD COLUMN reservation_key uuid;

CREATE INDEX capacity_holds_reservation_idx
  ON capacity_holds(org_id, checkout_id, reservation_key);
