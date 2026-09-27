ALTER TABLE store_registration_addons
  ADD COLUMN active boolean NOT NULL DEFAULT true,
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);

CREATE INDEX store_registration_addons_offering_idx
  ON store_registration_addons(org_id, offering_id, active);
