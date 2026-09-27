CREATE TABLE chat_notification_batches (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  conversation_id uuid NOT NULL,
  recipient_account_id uuid NOT NULL REFERENCES accounts(id),
  first_message_id uuid NOT NULL,
  latest_message_id uuid NOT NULL,
  message_count integer NOT NULL DEFAULT 1 CHECK (message_count > 0),
  window_started_at timestamptz NOT NULL,
  available_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  claimed_at timestamptz,
  push_sent_at timestamptz,
  email_sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, conversation_id) REFERENCES conversations(org_id, id),
  FOREIGN KEY (org_id, first_message_id) REFERENCES chat_messages(org_id, id),
  FOREIGN KEY (org_id, latest_message_id) REFERENCES chat_messages(org_id, id)
);
CREATE UNIQUE INDEX chat_notification_batches_open_idx
  ON chat_notification_batches(org_id, conversation_id, recipient_account_id)
  WHERE status = 'pending';
CREATE INDEX chat_notification_batches_due_idx
  ON chat_notification_batches(org_id, available_at, created_at)
  WHERE status IN ('pending', 'sending');
SELECT configure_spine_tenant_table('chat_notification_batches');
