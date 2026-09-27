CREATE FUNCTION configure_spine_tenant_table(table_name text, append_only boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  EXECUTE format(
    'CREATE POLICY %I ON %I TO athlentry_app USING (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid) WITH CHECK (org_id = NULLIF(current_setting(''app.org_id'', true), '''')::uuid)',
    table_name || '_scope', table_name
  );
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', table_name || '_set_updated_at', table_name);
  IF append_only THEN
    EXECUTE format('GRANT SELECT, INSERT ON %I TO athlentry_app', table_name);
  ELSE
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO athlentry_app', table_name);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION configure_spine_tenant_table(text, boolean) FROM PUBLIC;

CREATE TABLE people (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  first_name text NOT NULL CHECK (length(trim(first_name)) > 0),
  last_name text NOT NULL CHECK (length(trim(last_name)) > 0),
  preferred_name text,
  middle_name text,
  suffix text,
  date_of_birth date NOT NULL,
  gender text NOT NULL DEFAULT 'unspecified' CHECK (gender IN ('female', 'male', 'nonbinary', 'unspecified')),
  competition_gender text CHECK (competition_gender IN ('female', 'male', 'open')),
  email citext,
  phone_e164 text,
  address jsonb,
  graduation_year integer CHECK (graduation_year BETWEEN 1900 AND 2200),
  school_name text,
  photo_file_id uuid,
  media_consent text NOT NULL DEFAULT 'unknown' CHECK (media_consent IN ('granted', 'denied', 'unknown')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'merged', 'anonymized')),
  merged_into_id uuid,
  search_text tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(first_name, '') || ' ' || coalesce(last_name, '') || ' ' || coalesce(preferred_name, ''))) STORED,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, merged_into_id) REFERENCES people(org_id, id)
);
CREATE INDEX people_org_name_idx ON people(org_id, last_name, first_name) WHERE status = 'active';
CREATE INDEX people_org_search_idx ON people USING gin(search_text);
CREATE INDEX people_org_email_idx ON people(org_id, email) WHERE email IS NOT NULL;
CREATE INDEX people_merged_into_idx ON people(org_id, merged_into_id) WHERE merged_into_id IS NOT NULL;
SELECT configure_spine_tenant_table('people');

CREATE TABLE person_account_links (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  person_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  relationship text NOT NULL CHECK (relationship IN ('self', 'guardian')),
  verified_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id)
);
CREATE UNIQUE INDEX person_account_links_active_unique_idx ON person_account_links(org_id, person_id, account_id, relationship) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX person_account_links_self_idx ON person_account_links(org_id, person_id) WHERE relationship = 'self' AND revoked_at IS NULL;
CREATE INDEX person_account_links_account_idx ON person_account_links(account_id, org_id) WHERE revoked_at IS NULL;
SELECT configure_spine_tenant_table('person_account_links');

CREATE TABLE households (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  address jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX households_org_name_idx ON households(org_id, name) WHERE status = 'active';
SELECT configure_spine_tenant_table('households');

CREATE TABLE household_members (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  household_id uuid NOT NULL,
  person_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('guardian', 'athlete', 'other_adult', 'other_child')),
  is_primary_contact boolean NOT NULL DEFAULT false,
  receives_communications boolean NOT NULL DEFAULT true,
  financially_responsible boolean NOT NULL DEFAULT false,
  can_pick_up boolean NOT NULL DEFAULT false,
  custody_note_enc bytea,
  lives_here boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, household_id, person_id),
  FOREIGN KEY (org_id, household_id) REFERENCES households(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id)
);
CREATE INDEX household_members_person_idx ON household_members(org_id, person_id);
CREATE INDEX household_members_household_idx ON household_members(org_id, household_id, role);
SELECT configure_spine_tenant_table('household_members');

CREATE TABLE emergency_contacts (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  person_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  relationship text NOT NULL,
  phone_e164 text NOT NULL,
  alt_phone_e164 text,
  priority integer NOT NULL CHECK (priority > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, person_id, priority),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id)
);
CREATE INDEX emergency_contacts_person_idx ON emergency_contacts(org_id, person_id, priority);
SELECT configure_spine_tenant_table('emergency_contacts');

CREATE TABLE medical_profiles (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  person_id uuid NOT NULL,
  allergies_enc bytea,
  allergy_flags text[] NOT NULL DEFAULT '{}',
  conditions_enc bytea,
  medications_enc bytea,
  physician_name_enc bytea,
  physician_phone_enc bytea,
  insurance_carrier_enc bytea,
  insurance_policy_enc bytea,
  notes_enc bytea,
  updated_by uuid REFERENCES accounts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, person_id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id)
);
SELECT configure_spine_tenant_table('medical_profiles');

CREATE TABLE form_responses (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  form_definition_id uuid NOT NULL,
  definition_version integer NOT NULL CHECK (definition_version >= 1),
  subject_type text NOT NULL CHECK (subject_type IN ('person', 'registration', 'team_entry', 'volunteer_signup', 'evaluation', 'incident')),
  subject_id uuid NOT NULL,
  answers jsonb NOT NULL DEFAULT '{}'::jsonb,
  answers_enc bytea,
  submitted_by_account_id uuid NOT NULL REFERENCES accounts(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  supersedes_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, form_definition_id) REFERENCES form_definitions(org_id, id),
  FOREIGN KEY (org_id, supersedes_id) REFERENCES form_responses(org_id, id)
);
CREATE INDEX form_responses_subject_idx ON form_responses(org_id, subject_type, subject_id);
CREATE INDEX form_responses_definition_idx ON form_responses(org_id, form_definition_id);
SELECT configure_spine_tenant_table('form_responses', true);

CREATE TABLE waiver_signatures (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  waiver_document_id uuid NOT NULL,
  document_version integer NOT NULL CHECK (document_version >= 1),
  document_hash bytea NOT NULL CHECK (octet_length(document_hash) = 32),
  participant_person_id uuid NOT NULL,
  signer_account_id uuid NOT NULL REFERENCES accounts(id),
  signer_person_id uuid,
  signer_name_typed text NOT NULL CHECK (length(trim(signer_name_typed)) > 0),
  signature_file_id uuid,
  method text NOT NULL CHECK (method IN ('online_typed', 'online_drawn', 'paper_recorded_by_staff')),
  registration_id uuid,
  ip inet,
  user_agent text,
  signed_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, waiver_document_id) REFERENCES waiver_documents(org_id, id),
  FOREIGN KEY (org_id, participant_person_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, signer_person_id) REFERENCES people(org_id, id)
);
CREATE INDEX waiver_signatures_participant_idx ON waiver_signatures(org_id, participant_person_id, signed_at DESC);
CREATE INDEX waiver_signatures_document_idx ON waiver_signatures(org_id, waiver_document_id);
CREATE INDEX waiver_signatures_registration_idx ON waiver_signatures(org_id, registration_id) WHERE registration_id IS NOT NULL;
SELECT configure_spine_tenant_table('waiver_signatures', true);

CREATE TABLE person_merges (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  survivor_id uuid NOT NULL,
  merged_id uuid NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  performed_by uuid NOT NULL REFERENCES accounts(id),
  performed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK (survivor_id <> merged_id),
  FOREIGN KEY (org_id, survivor_id) REFERENCES people(org_id, id),
  FOREIGN KEY (org_id, merged_id) REFERENCES people(org_id, id)
);
CREATE INDEX person_merges_survivor_idx ON person_merges(org_id, survivor_id);
CREATE INDEX person_merges_merged_idx ON person_merges(org_id, merged_id);
SELECT configure_spine_tenant_table('person_merges', true);
