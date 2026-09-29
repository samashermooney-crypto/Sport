CREATE TABLE org_onboarding_items (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  key text NOT NULL CHECK (key IN (
    'connect_payments', 'users_roles', 'choose_sports', 'create_program',
    'add_facilities', 'configure_compliance', 'import_members',
    'publish_website', 'open_registration'
  )),
  dismissed_at timestamptz,
  dismissed_by uuid REFERENCES accounts(id),
  completed_at timestamptz,
  completed_by_event text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, key)
);
SELECT configure_spine_tenant_table('org_onboarding_items');
CREATE INDEX org_onboarding_items_dismissed_by_idx ON org_onboarding_items(dismissed_by) WHERE dismissed_by IS NOT NULL;

CREATE TABLE support_requests (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN ('support', 'concierge_import')),
  subject text NOT NULL CHECK (length(trim(subject)) > 0),
  body text NOT NULL CHECK (length(trim(body)) > 0),
  context jsonb NOT NULL DEFAULT '{}',
  contact_email citext,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'sent', 'failed', 'closed')),
  created_by uuid NOT NULL REFERENCES accounts(id),
  notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX support_requests_org_idx ON support_requests(org_id, created_at DESC);
CREATE INDEX support_requests_created_by_idx ON support_requests(created_by);
SELECT configure_spine_tenant_table('support_requests');

CREATE TABLE ai_usage_events (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  feature text NOT NULL CHECK (feature IN ('form_draft', 'translation', 'help_assistant')),
  actor_account_id uuid REFERENCES accounts(id),
  model text NOT NULL,
  prompt_tokens integer NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens integer NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  redactions integer NOT NULL DEFAULT 0 CHECK (redactions >= 0),
  status text NOT NULL CHECK (status IN ('ok', 'refused', 'error', 'capped')),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX ai_usage_events_org_month_idx ON ai_usage_events(org_id, created_at);
CREATE INDEX ai_usage_events_actor_idx ON ai_usage_events(actor_account_id) WHERE actor_account_id IS NOT NULL;
SELECT configure_spine_tenant_table('ai_usage_events', true);

CREATE TABLE ai_drafts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind = 'form'),
  source_file_name text,
  draft jsonb NOT NULL,
  redactions integer NOT NULL DEFAULT 0 CHECK (redactions >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'discarded')),
  created_by uuid NOT NULL REFERENCES accounts(id),
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX ai_drafts_org_idx ON ai_drafts(org_id, status, created_at DESC);
CREATE INDEX ai_drafts_created_by_idx ON ai_drafts(created_by);
SELECT configure_spine_tenant_table('ai_drafts');

CREATE TABLE ai_conversations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  account_id uuid REFERENCES accounts(id),
  visitor_key text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK ((account_id IS NOT NULL) <> (visitor_key IS NOT NULL))
);
CREATE INDEX ai_conversations_expiry_idx ON ai_conversations(expires_at);
CREATE INDEX ai_conversations_account_idx ON ai_conversations(account_id) WHERE account_id IS NOT NULL;
SELECT configure_spine_tenant_table('ai_conversations');

CREATE TABLE ai_conversation_messages (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  conversation_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('visitor', 'assistant')),
  content text NOT NULL,
  citations jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, conversation_id) REFERENCES ai_conversations(org_id, id)
);
CREATE INDEX ai_conversation_messages_idx ON ai_conversation_messages(org_id, conversation_id, created_at);
SELECT configure_spine_tenant_table('ai_conversation_messages');

CREATE TABLE phase15_import_batches (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN (
    'people', 'households', 'registrations', 'teams', 'rosters', 'schedule',
    'facilities', 'credentials', 'historical_payments', 'volunteer_hours'
  )),
  file_id uuid,
  file_name text NOT NULL CHECK (length(trim(file_name)) > 0),
  file_bytes integer NOT NULL CHECK (file_bytes > 0),
  mapping jsonb,
  mapping_preset_id uuid,
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN (
    'uploaded', 'mapped', 'validating', 'validated', 'committing',
    'committed', 'failed', 'rolled_back'
  )),
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  error_count integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  progress jsonb NOT NULL DEFAULT '{"processed": 0, "total": 0}',
  summary jsonb,
  created_by uuid NOT NULL REFERENCES accounts(id),
  committed_at timestamptz,
  rolled_back_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, file_id) REFERENCES files(org_id, id)
);
CREATE INDEX phase15_import_batches_org_status_idx ON phase15_import_batches(org_id, status, created_at DESC);
CREATE INDEX phase15_import_batches_file_idx ON phase15_import_batches(org_id, file_id) WHERE file_id IS NOT NULL;
SELECT configure_spine_tenant_table('phase15_import_batches');

CREATE TABLE phase15_import_rows (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  batch_id uuid NOT NULL,
  row_number integer NOT NULL CHECK (row_number > 0),
  raw jsonb NOT NULL,
  normalized jsonb,
  issues jsonb NOT NULL DEFAULT '[]',
  duplicates jsonb NOT NULL DEFAULT '[]',
  action text NOT NULL DEFAULT 'create' CHECK (action IN ('create', 'update', 'merge', 'skip')),
  target_id uuid,
  target_version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, batch_id, row_number),
  FOREIGN KEY (org_id, batch_id) REFERENCES phase15_import_batches(org_id, id)
);
CREATE INDEX phase15_import_rows_batch_idx ON phase15_import_rows(org_id, batch_id, row_number);
CREATE INDEX phase15_import_rows_target_idx ON phase15_import_rows(org_id, target_id) WHERE target_id IS NOT NULL;
SELECT configure_spine_tenant_table('phase15_import_rows');

CREATE TABLE phase15_import_mapping_presets (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN (
    'people', 'households', 'registrations', 'teams', 'rosters', 'schedule',
    'facilities', 'credentials', 'historical_payments', 'volunteer_hours'
  )),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  mapping jsonb NOT NULL,
  builtin boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, kind, name)
);
ALTER TABLE phase15_import_mapping_presets ENABLE ROW LEVEL SECURITY;
ALTER TABLE phase15_import_mapping_presets FORCE ROW LEVEL SECURITY;
CREATE POLICY phase15_import_mapping_presets_scope ON phase15_import_mapping_presets TO athlentry_app
  USING (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  );
CREATE INDEX phase15_import_mapping_presets_created_by_idx ON phase15_import_mapping_presets(created_by) WHERE created_by IS NOT NULL;
CREATE TRIGGER phase15_import_mapping_presets_set_updated_at
  BEFORE UPDATE ON phase15_import_mapping_presets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE ON phase15_import_mapping_presets TO athlentry_app;
ALTER TABLE phase15_import_batches
  ADD CONSTRAINT phase15_import_batches_mapping_preset_fk
  FOREIGN KEY (org_id, mapping_preset_id)
  REFERENCES phase15_import_mapping_presets(org_id, id);
CREATE INDEX phase15_import_batches_created_by_idx ON phase15_import_batches(created_by);
