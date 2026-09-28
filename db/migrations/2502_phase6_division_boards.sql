ALTER TABLE placement_boards
  ADD COLUMN division_id uuid,
  ADD CONSTRAINT placement_boards_division_fk
    FOREIGN KEY (org_id,division_id) REFERENCES divisions(org_id,id);
CREATE INDEX placement_boards_division_idx ON placement_boards(org_id,target_program_id,division_id,status);
