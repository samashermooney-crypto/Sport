-- Keep the registration spine's foreign-key delete and update checks indexed.
CREATE INDEX registration_add_on_invoice_line_fk_idx
  ON registration_add_on_selections(org_id, invoice_line_id)
  WHERE invoice_line_id IS NOT NULL;
CREATE INDEX team_entry_invites_accepted_registration_fk_idx
  ON team_entry_invites(org_id, accepted_registration_id)
  WHERE accepted_registration_id IS NOT NULL;
CREATE INDEX team_entry_invites_person_fk_idx
  ON team_entry_invites(org_id, person_id)
  WHERE person_id IS NOT NULL;
CREATE INDEX team_entry_invites_invited_by_fk_idx
  ON team_entry_invites(invited_by);
CREATE INDEX registration_notice_outbox_account_fk_idx
  ON registration_notice_outbox(account_id);
