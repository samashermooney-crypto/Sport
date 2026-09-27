ALTER TABLE credential_reminder_events ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE background_check_webhook_events ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE background_check_orders ADD COLUMN disclosure_text text;

ALTER TABLE return_to_play_clearances
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE return_to_play_clearances
  DROP CONSTRAINT return_to_play_clearances_org_id_injury_report_id_key;
CREATE UNIQUE INDEX return_to_play_one_pending_clearance_idx
  ON return_to_play_clearances(org_id, injury_report_id)
  WHERE review_status = 'pending_review';

-- This global index contains provider identifiers and tenant locators only. Its sole use is
-- resolving a signed provider webhook to the organization before entering withOrg().
CREATE TABLE background_check_provider_index (
  provider text NOT NULL CHECK (provider = 'checkr'),
  report_id text NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id),
  order_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, report_id),
  UNIQUE (org_id, order_id),
  FOREIGN KEY (org_id, order_id) REFERENCES background_check_orders(org_id, id)
);
GRANT SELECT, INSERT ON background_check_provider_index TO athlentry_app;
