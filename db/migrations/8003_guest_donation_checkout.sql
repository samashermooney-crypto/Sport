ALTER TABLE donations ADD COLUMN checkout_session_id text;
ALTER TABLE donations ADD COLUMN provider_payment_id text;
ALTER TABLE donations ADD COLUMN creation_key uuid;
CREATE UNIQUE INDEX donations_creation_once_idx
  ON donations(org_id, creation_key) WHERE creation_key IS NOT NULL;
CREATE UNIQUE INDEX donations_checkout_session_once_idx
  ON donations(org_id, checkout_session_id) WHERE checkout_session_id IS NOT NULL;
CREATE UNIQUE INDEX donations_provider_payment_once_idx
  ON donations(org_id, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
