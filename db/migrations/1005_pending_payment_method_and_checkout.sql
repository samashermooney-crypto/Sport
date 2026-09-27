ALTER TABLE payments DROP CONSTRAINT payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check
  CHECK (method IN ('unknown', 'card', 'us_bank_account', 'link', 'apple_pay',
    'google_pay', 'cash', 'check', 'external'));

ALTER TABLE payments
  ADD COLUMN checkout_id uuid,
  ADD CONSTRAINT payments_checkout_fk
    FOREIGN KEY (org_id, checkout_id) REFERENCES checkouts(org_id, id);

CREATE INDEX payments_checkout_idx ON payments(org_id, checkout_id)
  WHERE checkout_id IS NOT NULL;
