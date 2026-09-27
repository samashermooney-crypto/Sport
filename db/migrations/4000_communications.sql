ALTER TABLE message_deliveries DROP CONSTRAINT message_deliveries_check;
ALTER TABLE message_deliveries ADD CONSTRAINT message_deliveries_has_source_check
  CHECK ((campaign_id IS NOT NULL) <> (notification_id IS NOT NULL));
ALTER TABLE message_deliveries
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 5),
  ADD COLUMN next_attempt_at timestamptz,
  ADD COLUMN last_attempt_at timestamptz;
CREATE INDEX message_deliveries_retry_idx
  ON message_deliveries(next_attempt_at, created_at)
  WHERE status IN ('queued', 'failed') AND attempt_count < 5;
CREATE UNIQUE INDEX message_deliveries_provider_idx
  ON message_deliveries(channel, provider_message_id)
  WHERE provider_message_id IS NOT NULL;

-- Opaque provider identifiers are a global webhook locator only; the matching
-- delivery record is always loaded and updated inside its tenant withOrg scope.
CREATE TABLE provider_delivery_keys (
  channel text NOT NULL CHECK (channel IN ('email', 'sms')),
  provider_id text NOT NULL,
  tenant_org_id uuid NOT NULL REFERENCES organizations(id),
  delivery_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel, provider_id),
  UNIQUE (channel, tenant_org_id, delivery_id),
  FOREIGN KEY (tenant_org_id, delivery_id) REFERENCES message_deliveries(org_id, id)
);
ALTER TABLE provider_delivery_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_delivery_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_delivery_keys_lookup ON provider_delivery_keys FOR SELECT TO athlentry_app USING (true);
CREATE POLICY provider_delivery_keys_insert ON provider_delivery_keys FOR INSERT TO athlentry_app
  WITH CHECK (tenant_org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
CREATE TRIGGER provider_delivery_keys_set_updated_at BEFORE UPDATE ON provider_delivery_keys FOR EACH ROW EXECUTE FUNCTION set_updated_at();
GRANT SELECT, INSERT ON provider_delivery_keys TO athlentry_app;

CREATE TABLE communication_consent_events (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  action text NOT NULL CHECK (action IN ('granted', 'revoked')),
  source text NOT NULL CHECK (source IN ('settings', 'twilio_stop', 'twilio_start')),
  provider_message_id text,
  version text NOT NULL,
  consent_text text NOT NULL CHECK (length(consent_text) > 0),
  ip inet,
  user_agent text,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);
CREATE INDEX communication_consent_latest_idx
  ON communication_consent_events(org_id, account_id, phone_e164, accepted_at DESC, id DESC);
CREATE UNIQUE INDEX communication_consent_provider_message_idx
  ON communication_consent_events(org_id, account_id, source, provider_message_id) WHERE provider_message_id IS NOT NULL;
SELECT configure_spine_tenant_table('communication_consent_events', true);

CREATE TABLE communication_sender_identities (
  org_id uuid PRIMARY KEY REFERENCES organizations(id),
  display_name text CHECK (display_name IS NULL OR length(trim(display_name)) BETWEEN 1 AND 120),
  reply_to citext,
  sms_compliance_text text,
  reply_to_verification_hash bytea,
  reply_to_verification_expires_at timestamptz,
  reply_to_verified_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by uuid NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
SELECT configure_spine_tenant_table('communication_sender_identities');

-- A signed Twilio STOP applies to the number in every organization. Only SMS
-- STOP rows may use NULL org_id; tenant writes remain org-scoped.
DROP POLICY suppressions_insert ON suppressions;
CREATE POLICY suppressions_insert ON suppressions FOR INSERT TO athlentry_app
  WITH CHECK (
    (org_id IS NOT NULL AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
    OR (org_id IS NULL AND channel = 'sms' AND reason = 'stop')
  );
DROP POLICY suppressions_update ON suppressions;
CREATE POLICY suppressions_update ON suppressions FOR UPDATE TO athlentry_app
  USING (
    (org_id IS NOT NULL AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
    OR (org_id IS NULL AND channel = 'sms' AND reason = 'stop')
  )
  WITH CHECK (
    (org_id IS NOT NULL AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
    OR (org_id IS NULL AND channel = 'sms' AND reason = 'stop')
  );
GRANT DELETE ON suppressions TO athlentry_app;
CREATE POLICY suppressions_delete ON suppressions FOR DELETE TO athlentry_app
  USING (
    (org_id IS NOT NULL AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
    OR (org_id IS NULL AND channel = 'sms' AND reason = 'stop')
  );
