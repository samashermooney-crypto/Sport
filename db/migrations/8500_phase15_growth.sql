-- Phase 15 (Track K): onboarding checklist, import framework, support
-- requests, AI assist bookkeeping, and the 02 §K volunteer spine the
-- volunteer-hours import targets. Every tenant table goes through
-- configure_spine_tenant_table for RLS + updated_at.

CREATE TABLE org_onboarding_items (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  key text NOT NULL CHECK (key IN (
    'connect_payments', 'users_roles', 'choose_sports', 'create_program',
    'add_facilities', 'configure_compliance', 'import_members',
    'publish_website', 'open_registration'
  )),
  dismissed_at timestamptz,
  dismissed_by uuid,
  completed_at timestamptz,
  completed_by_event text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, key)
);
SELECT configure_spine_tenant_table('org_onboarding_items');

CREATE TABLE import_batches (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN (
    'people', 'households', 'registrations', 'teams', 'rosters', 'schedule',
    'facilities', 'credentials', 'historical_payments', 'volunteer_hours'
  )),
  file_id uuid,
  file_name text NOT NULL,
  file_bytes integer NOT NULL CHECK (file_bytes >= 0),
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
  created_by uuid NOT NULL,
  committed_at timestamptz,
  rolled_back_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, file_id) REFERENCES files(org_id, id)
);
CREATE INDEX import_batches_org_status_idx ON import_batches(org_id, status, created_at DESC);
CREATE INDEX import_batches_file_idx ON import_batches(org_id, file_id) WHERE file_id IS NOT NULL;
SELECT configure_spine_tenant_table('import_batches');

CREATE TABLE import_rows (
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
  FOREIGN KEY (org_id, batch_id) REFERENCES import_batches(org_id, id)
);
CREATE INDEX import_rows_batch_idx ON import_rows(org_id, batch_id, row_number);
CREATE INDEX import_rows_target_idx ON import_rows(org_id, target_id) WHERE target_id IS NOT NULL;
SELECT configure_spine_tenant_table('import_rows');

CREATE TABLE mapping_presets (
  id uuid PRIMARY KEY,
  org_id uuid REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN (
    'people', 'households', 'registrations', 'teams', 'rosters', 'schedule',
    'facilities', 'credentials', 'historical_payments', 'volunteer_hours'
  )),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  mapping jsonb NOT NULL,
  builtin bool NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, name)
);
-- Global presets (org_id IS NULL) must remain readable by every tenant, so
-- this table gets a permissive read policy plus org-scoped writes instead of
-- the standard single-tenant policy.
ALTER TABLE mapping_presets ENABLE ROW LEVEL SECURITY;
ALTER TABLE mapping_presets FORCE ROW LEVEL SECURITY;
CREATE POLICY mapping_presets_scope ON mapping_presets TO athlentry_app
  USING (
    org_id IS NULL
    OR org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  )
  WITH CHECK (
    org_id IS NOT NULL
    AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
  );
CREATE TRIGGER mapping_presets_set_updated_at BEFORE UPDATE ON mapping_presets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT, UPDATE ON mapping_presets TO athlentry_app;

CREATE TABLE support_requests (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN ('support', 'concierge_import')),
  subject text NOT NULL CHECK (length(trim(subject)) > 0),
  body text NOT NULL CHECK (length(trim(body)) > 0),
  context jsonb NOT NULL DEFAULT '{}',
  contact_email citext,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'sent', 'failed', 'closed')),
  created_by uuid NOT NULL,
  notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX support_requests_org_idx ON support_requests(org_id, created_at DESC);
SELECT configure_spine_tenant_table('support_requests');

CREATE TABLE ai_usage_events (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  feature text NOT NULL CHECK (feature IN ('form_draft', 'translation', 'help_assistant')),
  actor_account_id uuid,
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
SELECT configure_spine_tenant_table('ai_usage_events', true);

CREATE TABLE ai_drafts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN ('form')),
  source_file_name text,
  draft jsonb NOT NULL,
  redactions integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'discarded')),
  created_by uuid NOT NULL,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX ai_drafts_org_idx ON ai_drafts(org_id, status, created_at DESC);
SELECT configure_spine_tenant_table('ai_drafts');

CREATE TABLE ai_conversations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  account_id uuid,
  visitor_key text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX ai_conversations_expiry_idx ON ai_conversations(expires_at);
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

-- 02 §K volunteer spine (owned by Track H's Phase 11 work; created here so the
-- volunteer-hours import target exists — extend with ALTER migrations).
CREATE TABLE volunteer_roles (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  description text,
  minimum_age integer CHECK (minimum_age IS NULL OR minimum_age >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX volunteer_roles_org_idx ON volunteer_roles(org_id, name);
SELECT configure_spine_tenant_table('volunteer_roles');

CREATE TABLE volunteer_requirements (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  season_id uuid,
  program_id uuid,
  unit text NOT NULL CHECK (unit IN ('hours', 'shifts')),
  amount_per_household numeric,
  amount_per_athlete numeric,
  buyout_price_cents bigint CHECK (buyout_price_cents IS NULL OR buyout_price_cents >= 0),
  buyout_offering_id uuid,
  deadline date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, season_id) REFERENCES seasons(org_id, id),
  FOREIGN KEY (org_id, program_id) REFERENCES programs(org_id, id)
);
CREATE INDEX volunteer_requirements_org_idx ON volunteer_requirements(org_id);
SELECT configure_spine_tenant_table('volunteer_requirements');

CREATE TABLE volunteer_shifts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  volunteer_role_id uuid,
  event_id uuid,
  facility_id uuid,
  title text,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  slots integer NOT NULL DEFAULT 1 CHECK (slots > 0),
  credit_hours numeric NOT NULL DEFAULT 0 CHECK (credit_hours >= 0),
  notes text,
  imported bool NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, volunteer_role_id) REFERENCES volunteer_roles(org_id, id),
  FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id),
  FOREIGN KEY (org_id, facility_id) REFERENCES facilities(org_id, id)
);
CREATE INDEX volunteer_shifts_org_time_idx ON volunteer_shifts(org_id, starts_at);
SELECT configure_spine_tenant_table('volunteer_shifts');

CREATE TABLE volunteer_signups (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  volunteer_shift_id uuid NOT NULL,
  person_id uuid NOT NULL,
  household_id uuid,
  status text NOT NULL DEFAULT 'signed_up' CHECK (status IN (
    'signed_up', 'confirmed', 'checked_in', 'completed', 'no_show', 'canceled'
  )),
  hours_credited numeric NOT NULL DEFAULT 0 CHECK (hours_credited >= 0),
  credited_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, volunteer_shift_id) REFERENCES volunteer_shifts(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, household_id) REFERENCES households(org_id, id)
);
CREATE INDEX volunteer_signups_shift_idx ON volunteer_signups(org_id, volunteer_shift_id);
CREATE INDEX volunteer_signups_person_idx ON volunteer_signups(org_id, person_id);
CREATE INDEX volunteer_signups_household_idx ON volunteer_signups(org_id, household_id) WHERE household_id IS NOT NULL;
SELECT configure_spine_tenant_table('volunteer_signups');
