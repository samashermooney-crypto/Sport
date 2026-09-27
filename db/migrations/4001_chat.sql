ALTER TABLE conversation_members
  ADD COLUMN guardian_copied boolean NOT NULL DEFAULT false;
CREATE INDEX conversation_members_active_idx
  ON conversation_members(org_id, conversation_id, role, account_id);

ALTER TABLE chat_reports
  ADD COLUMN incident_report_id uuid;
ALTER TABLE chat_reports
  ADD CONSTRAINT chat_reports_incident_report_fk
  FOREIGN KEY (org_id, incident_report_id) REFERENCES incident_reports(org_id, id);
CREATE INDEX chat_reports_incident_idx
  ON chat_reports(org_id, incident_report_id)
  WHERE incident_report_id IS NOT NULL;
