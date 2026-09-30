-- Standings scopes whose recompute was skipped because another transaction
-- was recomputing the same scope at the same moment (bursts of finalized
-- results). The standings worker recomputes and clears them.
CREATE TABLE standings_dirty_scopes (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  scope_type text NOT NULL CHECK (scope_type IN ('program', 'division')),
  scope_id uuid NOT NULL,
  marked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, scope_type, scope_id)
);
SELECT configure_spine_tenant_table('standings_dirty_scopes');
GRANT DELETE ON standings_dirty_scopes TO athlentry_app;
