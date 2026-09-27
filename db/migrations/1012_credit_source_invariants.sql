ALTER TABLE credits
  ADD CONSTRAINT credits_one_recipient_check
    CHECK ((account_id IS NOT NULL) <> (household_id IS NOT NULL)),
  ADD CONSTRAINT credits_source_kind_check
    CHECK ((kind = 'issued') = (source_credit_id IS NULL)),
  ADD CONSTRAINT credits_reversal_negative_check
    CHECK (kind <> 'reversed' OR amount_cents < 0);

CREATE FUNCTION assert_credit_source_reconciled(credit_org uuid, source_key uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  source_row credits%ROWTYPE;
  debits bigint;
BEGIN
  SELECT * INTO source_row FROM credits
    WHERE org_id = credit_org AND id = source_key AND kind = 'issued'
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credit source is missing'; END IF;
  IF EXISTS (
    SELECT 1 FROM credits debit
    WHERE debit.org_id = credit_org AND debit.source_credit_id = source_key
      AND (debit.account_id IS DISTINCT FROM source_row.account_id
        OR debit.household_id IS DISTINCT FROM source_row.household_id)
  ) THEN
    RAISE EXCEPTION 'Credit debit recipient differs from source';
  END IF;
  SELECT coalesce(-sum(amount_cents), 0)::bigint INTO debits FROM credits
    WHERE org_id = credit_org AND source_credit_id = source_key;
  IF debits > source_row.amount_cents THEN
    RAISE EXCEPTION 'Credit source is overdrawn';
  END IF;
END;
$$;

CREATE FUNCTION reconcile_credit_source_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'issued' THEN
    PERFORM assert_credit_source_reconciled(NEW.org_id, NEW.id);
  ELSE
    PERFORM assert_credit_source_reconciled(NEW.org_id, NEW.source_credit_id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER credits_source_reconcile
  AFTER INSERT ON credits
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION reconcile_credit_source_trigger();

CREATE FUNCTION prevent_credit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Credit ledger entries are append-only';
END;
$$;
CREATE TRIGGER credits_prevent_update BEFORE UPDATE ON credits
  FOR EACH ROW EXECUTE FUNCTION prevent_credit_mutation();
CREATE TRIGGER credits_prevent_delete BEFORE DELETE ON credits
  FOR EACH ROW EXECUTE FUNCTION prevent_credit_mutation();
