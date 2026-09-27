ALTER TABLE volunteer_shifts
  ADD COLUMN requirement_id uuid,
  ADD CONSTRAINT volunteer_shifts_requirement_fk
    FOREIGN KEY (org_id, requirement_id) REFERENCES volunteer_requirements(org_id, id);
CREATE INDEX volunteer_shifts_requirement_idx ON volunteer_shifts(org_id, requirement_id, starts_at) WHERE requirement_id IS NOT NULL;
