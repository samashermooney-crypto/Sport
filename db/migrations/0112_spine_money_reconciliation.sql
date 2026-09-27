CREATE TABLE refund_allocations (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id),
  refund_id uuid NOT NULL,
  invoice_line_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  UNIQUE (org_id, refund_id, invoice_line_id),
  FOREIGN KEY (org_id, refund_id) REFERENCES refunds(org_id, id),
  FOREIGN KEY (org_id, invoice_line_id) REFERENCES invoice_lines(org_id, id)
);
CREATE INDEX refund_allocations_refund_idx ON refund_allocations(org_id, refund_id);
CREATE INDEX refund_allocations_line_idx ON refund_allocations(org_id, invoice_line_id);
SELECT configure_spine_tenant_table('refund_allocations', true);

CREATE FUNCTION assert_invoice_reconciled(invoice_org uuid, invoice_key uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  header invoices%ROWTYPE;
  line_total bigint;
  allocated_total bigint;
  refunded_total bigint;
BEGIN
  SELECT * INTO header FROM invoices WHERE org_id = invoice_org AND id = invoice_key;
  IF NOT FOUND OR header.status = 'draft' THEN RETURN; END IF;
  SELECT coalesce(sum(amount_cents), 0)::bigint INTO line_total
    FROM invoice_lines WHERE org_id = invoice_org AND invoice_id = invoice_key;
  SELECT coalesce(sum(allocation.amount_cents), 0)::bigint INTO allocated_total
    FROM payment_allocations allocation
    JOIN payments payment ON payment.org_id = allocation.org_id AND payment.id = allocation.payment_id
    WHERE allocation.org_id = invoice_org AND allocation.invoice_id = invoice_key
      AND payment.status = 'succeeded';
  SELECT coalesce(sum(allocation.amount_cents), 0)::bigint INTO refunded_total
    FROM refund_allocations allocation
    JOIN refunds refund ON refund.org_id = allocation.org_id AND refund.id = allocation.refund_id
    JOIN invoice_lines line ON line.org_id = allocation.org_id AND line.id = allocation.invoice_line_id
    WHERE line.org_id = invoice_org AND line.invoice_id = invoice_key
      AND refund.status = 'succeeded';
  IF line_total <> header.total_cents THEN
    RAISE EXCEPTION 'Invoice line total does not reconcile with header';
  END IF;
  IF allocated_total <> header.paid_cents THEN
    RAISE EXCEPTION 'Invoice payment allocations do not reconcile with header';
  END IF;
  IF refunded_total <> header.refunded_cents THEN
    RAISE EXCEPTION 'Invoice refund allocations do not reconcile with header';
  END IF;
END;
$$;

CREATE FUNCTION reconcile_invoice_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'invoices' THEN
    PERFORM assert_invoice_reconciled(NEW.org_id, NEW.id);
  ELSIF TG_TABLE_NAME = 'invoice_lines' THEN
    PERFORM assert_invoice_reconciled(NEW.org_id, NEW.invoice_id);
  ELSIF TG_TABLE_NAME = 'payment_allocations' THEN
    PERFORM assert_invoice_reconciled(NEW.org_id, NEW.invoice_id);
  ELSIF TG_TABLE_NAME = 'refund_allocations' THEN
    PERFORM assert_invoice_reconciled(NEW.org_id, (
      SELECT invoice_id FROM invoice_lines
      WHERE org_id = NEW.org_id AND id = NEW.invoice_line_id
    ));
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER invoices_reconcile AFTER INSERT OR UPDATE ON invoices
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_invoice_trigger();
CREATE CONSTRAINT TRIGGER invoice_lines_reconcile AFTER INSERT OR UPDATE ON invoice_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_invoice_trigger();
CREATE CONSTRAINT TRIGGER payment_allocations_reconcile AFTER INSERT ON payment_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_invoice_trigger();
CREATE CONSTRAINT TRIGGER refund_allocations_reconcile AFTER INSERT ON refund_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_invoice_trigger();

CREATE FUNCTION reconcile_payment_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  payment_key uuid;
  payment_org uuid;
  payment_row payments%ROWTYPE;
  allocated_total bigint;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN
    payment_key := NEW.id; payment_org := NEW.org_id;
  ELSE
    payment_key := NEW.payment_id; payment_org := NEW.org_id;
  END IF;
  SELECT * INTO payment_row FROM payments WHERE org_id = payment_org AND id = payment_key;
  IF NOT FOUND OR payment_row.status <> 'succeeded' THEN RETURN NULL; END IF;
  SELECT coalesce(sum(amount_cents), 0)::bigint INTO allocated_total
    FROM payment_allocations WHERE org_id = payment_org AND payment_id = payment_key;
  IF allocated_total <> payment_row.amount_cents THEN
    RAISE EXCEPTION 'Successful payment allocations do not reconcile with payment amount';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER payments_reconcile AFTER INSERT OR UPDATE OF status, amount_cents ON payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_payment_trigger();
CREATE CONSTRAINT TRIGGER payment_allocations_payment_reconcile AFTER INSERT ON payment_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_payment_trigger();

CREATE FUNCTION reconcile_refund_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  refund_key uuid;
  refund_org uuid;
  refund_row refunds%ROWTYPE;
  allocated_total bigint;
BEGIN
  IF TG_TABLE_NAME = 'refunds' THEN
    refund_key := NEW.id; refund_org := NEW.org_id;
  ELSE
    refund_key := NEW.refund_id; refund_org := NEW.org_id;
  END IF;
  SELECT * INTO refund_row FROM refunds WHERE org_id = refund_org AND id = refund_key;
  IF NOT FOUND OR refund_row.status <> 'succeeded' THEN RETURN NULL; END IF;
  SELECT coalesce(sum(amount_cents), 0)::bigint INTO allocated_total
    FROM refund_allocations WHERE org_id = refund_org AND refund_id = refund_key;
  IF allocated_total <> refund_row.amount_cents THEN
    RAISE EXCEPTION 'Successful refund allocations do not reconcile with refund amount';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER refunds_reconcile AFTER INSERT OR UPDATE OF status, amount_cents ON refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_refund_trigger();
CREATE CONSTRAINT TRIGGER refund_allocations_refund_reconcile AFTER INSERT ON refund_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_refund_trigger();

CREATE FUNCTION reconcile_changed_settlement_invoices() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  invoice_key uuid;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN
    FOR invoice_key IN SELECT DISTINCT invoice_id FROM payment_allocations
      WHERE org_id = NEW.org_id AND payment_id = NEW.id
    LOOP
      PERFORM assert_invoice_reconciled(NEW.org_id, invoice_key);
    END LOOP;
  ELSE
    FOR invoice_key IN
      SELECT DISTINCT line.invoice_id
      FROM refund_allocations allocation
      JOIN invoice_lines line ON line.org_id = allocation.org_id AND line.id = allocation.invoice_line_id
      WHERE allocation.org_id = NEW.org_id AND allocation.refund_id = NEW.id
    LOOP
      PERFORM assert_invoice_reconciled(NEW.org_id, invoice_key);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER payments_invoice_reconcile AFTER UPDATE OF status ON payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_changed_settlement_invoices();
CREATE CONSTRAINT TRIGGER refunds_invoice_reconcile AFTER UPDATE OF status ON refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reconcile_changed_settlement_invoices();
