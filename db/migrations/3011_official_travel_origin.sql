ALTER TABLE official_profiles
  ADD COLUMN home_lat numeric(9,6),
  ADD COLUMN home_lng numeric(9,6),
  ADD CONSTRAINT official_profiles_home_coordinates_pair CHECK ((home_lat IS NULL) = (home_lng IS NULL)),
  ADD CONSTRAINT official_profiles_home_latitude CHECK (home_lat IS NULL OR home_lat BETWEEN -90 AND 90),
  ADD CONSTRAINT official_profiles_home_longitude CHECK (home_lng IS NULL OR home_lng BETWEEN -180 AND 180);
