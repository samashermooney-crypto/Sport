CREATE INDEX provider_delivery_keys_tenant_org_idx
  ON provider_delivery_keys(tenant_org_id);
CREATE INDEX provider_delivery_keys_delivery_idx
  ON provider_delivery_keys(tenant_org_id, delivery_id);
CREATE INDEX communication_consent_events_account_idx
  ON communication_consent_events(account_id);
CREATE INDEX communication_sender_identities_updated_by_idx
  ON communication_sender_identities(updated_by);
