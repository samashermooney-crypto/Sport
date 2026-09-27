ALTER TABLE background_check_orders
  ADD COLUMN pre_adverse_notice_delivered_at timestamptz,
  ADD COLUMN adverse_notice_delivered_at timestamptz;
