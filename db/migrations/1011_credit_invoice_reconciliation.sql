CREATE FUNCTION assert_invoice_credit_reconciled(invoice_org uuid, invoice_key uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  recorded bigint;
  applied bigint;
BEGIN
  SELECT credit_applied_cents INTO recorded FROM invoices
    WHERE org_id = invoice_org AND id = invoice_key;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT coalesce(-sum(amount_cents), 0)::bigint INTO applied FROM credits
    WHERE org_id = invoice_org AND invoice_id = invoice_key AND kind = 'applied';
  IF recorded <> applied THEN
    RAISE EXCEPTION 'Invoice credit applications do not reconcile with header';
  END IF;
END;
$$;

CREATE FUNCTION reconcile_invoice_credit_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'invoices' THEN
    PERFORM assert_invoice_credit_reconciled(NEW.org_id, NEW.id);
  ELSIF NEW.kind = 'applied' THEN
    PERFORM assert_invoice_credit_reconciled(NEW.org_id, NEW.invoice_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER invoices_credit_reconcile
  AFTER INSERT OR UPDATE OF credit_applied_cents ON invoices
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION reconcile_invoice_credit_trigger();
CREATE CONSTRAINT TRIGGER credits_invoice_reconcile
  AFTER INSERT ON credits
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION reconcile_invoice_credit_trigger();
