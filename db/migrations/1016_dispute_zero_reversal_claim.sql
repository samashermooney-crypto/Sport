ALTER TABLE dispute_liability_movements
  DROP CONSTRAINT dispute_liability_movements_amount_cents_check,
  ADD CONSTRAINT dispute_liability_movements_amount_cents_check
    CHECK (amount_cents >= 0),
  ADD CONSTRAINT dispute_liability_movements_recorded_liability_check
    CHECK (amount_cents > 0 OR unrecovered_cents > 0);
