ALTER TABLE evaluation_participants
  ADD COLUMN position_keys text[] NOT NULL DEFAULT '{}';

ALTER TABLE team_offers
  ADD COLUMN declined_by_account_id uuid REFERENCES accounts(id),
  ADD COLUMN reminder_sent_at timestamptz;
CREATE INDEX team_offers_reminder_idx ON team_offers(org_id,expires_at)
  WHERE status = 'sent' AND reminder_sent_at IS NULL;
