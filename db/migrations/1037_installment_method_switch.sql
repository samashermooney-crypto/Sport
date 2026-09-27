ALTER TABLE installment_staff_actions
  DROP CONSTRAINT installment_staff_actions_action_check;
ALTER TABLE installment_staff_actions
  ADD CONSTRAINT installment_staff_actions_action_check
  CHECK (action IN ('change_due_date', 'split', 'switch_payment_method'));
