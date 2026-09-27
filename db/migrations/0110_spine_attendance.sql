CREATE TABLE attendance (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  event_id uuid NOT NULL,
  person_id uuid NOT NULL,
  rsvp text NOT NULL DEFAULT 'none' CHECK (rsvp IN ('yes', 'no', 'maybe', 'none')),
  rsvp_by_account_id uuid REFERENCES accounts(id),
  status text NOT NULL DEFAULT 'unknown' CHECK (status IN ('present', 'absent', 'late', 'excused', 'unknown')),
  checked_in_at timestamptz,
  checked_in_by uuid REFERENCES accounts(id),
  checked_out_at timestamptz,
  picked_up_by_person_id uuid,
  roster_snapshot jsonb,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, event_id, person_id),
  CHECK (checked_out_at IS NULL OR checked_in_at IS NOT NULL),
  CHECK (checked_out_at IS NULL OR checked_out_at >= checked_in_at),
  FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, picked_up_by_person_id) REFERENCES people(org_id, id)
);
CREATE INDEX attendance_person_idx ON attendance(org_id, person_id, status, created_at DESC);
CREATE INDEX attendance_event_status_idx ON attendance(org_id, event_id, status);
CREATE INDEX attendance_pickup_idx ON attendance(org_id, picked_up_by_person_id) WHERE picked_up_by_person_id IS NOT NULL;
SELECT configure_spine_tenant_table('attendance');
