ALTER TABLE team_offers DROP CONSTRAINT team_offers_status_check;
ALTER TABLE team_offers ADD CONSTRAINT team_offers_status_check
  CHECK (status IN ('sent','accepting','accepted','declined','expired','withdrawn'));
