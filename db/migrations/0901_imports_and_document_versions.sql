ALTER TABLE form_definitions
  ADD COLUMN supersedes_id uuid;
ALTER TABLE form_definitions
  ADD CONSTRAINT form_definitions_supersedes_fk
  FOREIGN KEY (org_id, supersedes_id) REFERENCES form_definitions (org_id, id);
CREATE UNIQUE INDEX form_definitions_supersedes_unique
  ON form_definitions (org_id, supersedes_id) WHERE supersedes_id IS NOT NULL;

ALTER TABLE waiver_documents
  ADD COLUMN supersedes_id uuid;
ALTER TABLE waiver_documents
  ADD CONSTRAINT waiver_documents_supersedes_fk
  FOREIGN KEY (org_id, supersedes_id) REFERENCES waiver_documents (org_id, id);
CREATE UNIQUE INDEX waiver_documents_supersedes_unique
  ON waiver_documents (org_id, supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE TABLE import_batches (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (
    kind IN ('people', 'households', 'guardians', 'emergency_contacts')
  ),
  filename text NOT NULL CHECK (length(trim(filename)) > 0),
  status text NOT NULL DEFAULT 'preview' CHECK (
    status IN ('preview', 'committed', 'rolled_back', 'failed')
  ),
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL REFERENCES accounts(id),
  committed_at timestamptz,
  committed_by uuid REFERENCES accounts(id),
  rolled_back_at timestamptz,
  rolled_back_by uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX import_batches_org_created_idx
  ON import_batches (org_id, created_at DESC);
SELECT configure_spine_tenant_table('import_batches');

CREATE TABLE import_rows (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  row_number integer NOT NULL CHECK (row_number > 0),
  raw jsonb NOT NULL,
  normalized jsonb,
  action text NOT NULL DEFAULT 'create' CHECK (
    action IN ('create', 'update', 'skip', 'invalid')
  ),
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  entity_type text,
  entity_id uuid,
  created_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, batch_id, row_number),
  FOREIGN KEY (org_id, batch_id) REFERENCES import_batches (org_id, id)
);
SELECT configure_spine_tenant_table('import_rows');

CREATE TABLE import_mapping_presets (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (
    kind IN ('people', 'households', 'guardians', 'emergency_contacts')
  ),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  mapping jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, kind, name)
);
SELECT configure_spine_tenant_table('import_mapping_presets');
