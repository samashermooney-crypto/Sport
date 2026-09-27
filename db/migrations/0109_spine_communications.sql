CREATE TABLE message_campaigns (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  author_account_id uuid NOT NULL REFERENCES accounts(id),
  channels text[] NOT NULL CHECK (cardinality(channels) > 0 AND channels <@ ARRAY['email', 'sms', 'push', 'in_app']),
  subject text,
  body_html text,
  body_text text,
  sms_text text,
  locale_variants jsonb NOT NULL DEFAULT '{}'::jsonb,
  audience jsonb NOT NULL,
  category text NOT NULL CHECK (category IN ('operational', 'announcement', 'marketing', 'emergency')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'canceled', 'failed')),
  scheduled_for timestamptz,
  sent_at timestamptz,
  resolved_recipient_count integer CHECK (resolved_recipient_count IS NULL OR resolved_recipient_count >= 0),
  reply_to text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX message_campaigns_status_idx ON message_campaigns(org_id, status, scheduled_for);
CREATE INDEX message_campaigns_author_idx ON message_campaigns(org_id, author_account_id, created_at DESC);
SELECT configure_spine_tenant_table('message_campaigns');

CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at timestamptz,
  delivered_channels text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX notifications_unread_idx ON notifications(org_id, account_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX notifications_account_idx ON notifications(org_id, account_id, created_at DESC);
SELECT configure_spine_tenant_table('notifications');

CREATE TABLE message_deliveries (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  campaign_id uuid,
  notification_id uuid,
  recipient_account_id uuid NOT NULL REFERENCES accounts(id),
  person_id uuid,
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'in_app')),
  address text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'suppressed', 'sending', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'opened', 'clicked')),
  provider_message_id text,
  error text,
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  CHECK ((campaign_id IS NOT NULL) <> (notification_id IS NOT NULL)),
  FOREIGN KEY (org_id, campaign_id) REFERENCES message_campaigns(org_id, id),
  FOREIGN KEY (org_id, notification_id) REFERENCES notifications(org_id, id),
  FOREIGN KEY (org_id, person_id) REFERENCES people(org_id, id)
);
CREATE UNIQUE INDEX message_deliveries_campaign_recipient_idx ON message_deliveries(org_id, campaign_id, recipient_account_id, channel) WHERE campaign_id IS NOT NULL;
CREATE INDEX message_deliveries_recipient_idx ON message_deliveries(org_id, recipient_account_id, status, created_at DESC);
CREATE INDEX message_deliveries_notification_idx ON message_deliveries(org_id, notification_id) WHERE notification_id IS NOT NULL;
CREATE INDEX message_deliveries_person_idx ON message_deliveries(org_id, person_id) WHERE person_id IS NOT NULL;
SELECT configure_spine_tenant_table('message_deliveries');

CREATE TABLE suppressions (
  id uuid PRIMARY KEY,
  org_id uuid REFERENCES organizations(id),
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'push')),
  address text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('unsubscribe', 'bounce', 'complaint', 'stop', 'manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE NULLS NOT DISTINCT (org_id, channel, address)
);
CREATE INDEX suppressions_address_idx ON suppressions(channel, address);
CREATE TRIGGER suppressions_set_updated_at BEFORE UPDATE ON suppressions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppressions FORCE ROW LEVEL SECURITY;
CREATE POLICY suppressions_read ON suppressions FOR SELECT TO athlentry_app
  USING (org_id IS NULL OR org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY suppressions_insert ON suppressions FOR INSERT TO athlentry_app
  WITH CHECK (org_id IS NOT NULL AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
CREATE POLICY suppressions_update ON suppressions FOR UPDATE TO athlentry_app
  USING (org_id IS NOT NULL AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id IS NOT NULL AND org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON suppressions TO athlentry_app;

CREATE TABLE communication_preferences (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  account_id uuid NOT NULL REFERENCES accounts(id),
  category text NOT NULL CHECK (category IN ('operational', 'announcement', 'marketing', 'emergency')),
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'in_app')),
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, account_id, category, channel)
);
CREATE INDEX communication_preferences_account_idx ON communication_preferences(org_id, account_id, category);
SELECT configure_spine_tenant_table('communication_preferences');

CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  kind text NOT NULL CHECK (kind IN ('team', 'team_staff', 'announcement', 'group', 'direct')),
  team_season_id uuid,
  title text,
  created_by uuid NOT NULL REFERENCES accounts(id),
  archived_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, team_season_id) REFERENCES team_seasons(org_id, id)
);
CREATE INDEX conversations_team_idx ON conversations(org_id, team_season_id) WHERE team_season_id IS NOT NULL;
CREATE INDEX conversations_kind_idx ON conversations(org_id, kind, archived_at);
SELECT configure_spine_tenant_table('conversations');

CREATE TABLE conversation_members (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  conversation_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts(id),
  role text NOT NULL CHECK (role IN ('owner', 'member', 'read_only')),
  muted boolean NOT NULL DEFAULT false,
  last_read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, conversation_id, account_id),
  FOREIGN KEY (org_id, conversation_id) REFERENCES conversations(org_id, id)
);
CREATE INDEX conversation_members_account_idx ON conversation_members(org_id, account_id, last_read_at);
SELECT configure_spine_tenant_table('conversation_members');

CREATE TABLE chat_messages (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  conversation_id uuid NOT NULL,
  author_account_id uuid NOT NULL REFERENCES accounts(id),
  body text NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  edited_at timestamptz,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES accounts(id),
  reported_count integer NOT NULL DEFAULT 0 CHECK (reported_count >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, conversation_id) REFERENCES conversations(org_id, id)
);
CREATE INDEX chat_messages_conversation_idx ON chat_messages(org_id, conversation_id, created_at DESC);
CREATE INDEX chat_messages_author_idx ON chat_messages(org_id, author_account_id, created_at DESC);
SELECT configure_spine_tenant_table('chat_messages');

CREATE TABLE chat_reports (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  message_id uuid NOT NULL,
  reporter_account_id uuid NOT NULL REFERENCES accounts(id),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, message_id, reporter_account_id),
  FOREIGN KEY (org_id, message_id) REFERENCES chat_messages(org_id, id)
);
CREATE INDEX chat_reports_status_idx ON chat_reports(org_id, status, created_at DESC);
SELECT configure_spine_tenant_table('chat_reports');

CREATE TABLE message_templates (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'sms', 'push', 'in_app')),
  subject text,
  body text NOT NULL,
  locale text NOT NULL CHECK (locale IN ('en', 'es')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, name, channel, locale)
);
CREATE INDEX message_templates_channel_idx ON message_templates(org_id, channel, locale);
SELECT configure_spine_tenant_table('message_templates');
