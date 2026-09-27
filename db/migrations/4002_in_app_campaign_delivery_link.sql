ALTER TABLE message_deliveries
  DROP CONSTRAINT message_deliveries_has_source_check;

ALTER TABLE message_deliveries
  ADD CONSTRAINT message_deliveries_source_channel_check
  CHECK (
    (campaign_id IS NOT NULL AND notification_id IS NULL)
    OR (campaign_id IS NULL AND notification_id IS NOT NULL)
    OR (
      campaign_id IS NOT NULL
      AND notification_id IS NOT NULL
      AND channel = 'in_app'
    )
  );
