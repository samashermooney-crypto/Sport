CREATE TABLE allocation_requests (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  allocation_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES accounts(id),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'withdrawn')),
  decided_by uuid REFERENCES accounts(id),
  resulting_event_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (org_id, id),
  CHECK (starts_at < ends_at),
  CHECK ((status = 'pending' AND decided_by IS NULL) OR status <> 'pending'),
  FOREIGN KEY (org_id, allocation_id) REFERENCES allocations(org_id, id),
  FOREIGN KEY (org_id, resulting_event_id) REFERENCES events(org_id, id)
);
CREATE INDEX allocation_requests_pending_idx
  ON allocation_requests(org_id, allocation_id, starts_at)
  WHERE status = 'pending';
SELECT configure_spine_tenant_table('allocation_requests');
