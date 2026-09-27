ALTER TABLE checkouts
  ADD COLUMN invoice_id uuid,
  ADD CONSTRAINT checkouts_invoice_fk
    FOREIGN KEY (org_id, invoice_id) REFERENCES invoices(org_id, id);

CREATE UNIQUE INDEX checkouts_invoice_unique_idx
  ON checkouts(org_id, invoice_id) WHERE invoice_id IS NOT NULL;
