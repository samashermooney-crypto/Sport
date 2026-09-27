-- Every notification writer publishes the same account-scoped SSE envelope.
CREATE OR REPLACE FUNCTION publish_notification_delivery_event()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'athlentry_notifications',
    json_build_object('id', NEW.id, 'orgId', NEW.org_id,
                      'accountId', NEW.account_id)::text
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER notifications_publish_insert
AFTER INSERT ON notifications
FOR EACH ROW EXECUTE FUNCTION publish_notification_delivery_event();

CREATE TRIGGER notifications_publish_read
AFTER UPDATE OF read_at ON notifications
FOR EACH ROW WHEN (OLD.read_at IS DISTINCT FROM NEW.read_at)
EXECUTE FUNCTION publish_notification_delivery_event();
