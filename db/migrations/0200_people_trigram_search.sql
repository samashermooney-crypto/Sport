CREATE INDEX people_org_name_trgm_idx ON people USING gin
  ((first_name || ' ' || last_name) gin_trgm_ops)
  WHERE status = 'active';
