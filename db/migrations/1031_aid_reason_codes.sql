ALTER TABLE aid_applications
  ADD CONSTRAINT aid_decision_reason_code CHECK (decision_reason IN
    ('eligibility_not_met', 'incomplete_application', 'fund_exhausted',
      'other'));
