# Server integrations

Adapters are selected by the application composition root and receive credentials through validated configuration. Tests use fake adapters. Local development uses preview adapters; it must not use live delivery credentials.

## Email

`EmailSender` retains the original `{ to, subject, text }` contract and also accepts HTML and attachments. `FakeEmailSender` keeps sent messages in memory. Mailpit uses `ATHLENTRY_MAILPIT_SMTP_PORT` (default `1025`). Resend webhook requests must be verified using the raw request body and all three Svix headers before event handling. Security and transactional mail use the untracked `from` sender; campaigns require a different `campaignFrom` domain configured for open/click tracking in Resend. If the dedicated sender is not configured, campaign sends fail closed.

Auth email copy and the shared branded layout are in `email/templates/` and support `en` and `es`.

## SMS

Tests use `FakeSmsSender`; development can use `PreviewSmsSender`. Twilio sends through its Messaging Service and includes the configured HTTPS delivery status callback URL. Both inbound messages and status callbacks require X-Twilio-Signature validation with the exact externally configured URL. `handleTwilioInbound` calls a global suppression adapter on STOP and START so suppression applies across organizations.

## Push

`FakePushSender` and `PreviewPushSender` do not contact a push service. `WebPushSender` uses VAPID through the `web-push` package, reports 404/410 endpoints as invalid for subscription cleanup, and allows transient errors to reach the caller's retry policy. Track A owns subscription persistence.

## Files and storage

The files module stores metadata in Postgres under forced RLS. All tenant metadata access uses `withOrg`; upload permissions are checked at initiation and completion, and download permissions are checked when a short-lived link is issued and when local content is read. Storage adapters include memory, local disk, and an S3 Signature V4 client. Local adapters use authenticated API upload/download routes; S3 uploads sign the declared content type and exact content length. `SharpImageProcessor` rotates and re-encodes uploads as WebP and generates medium and thumbnail renditions without carrying EXIF/GPS metadata.

## Background checks and geocoding

`ManualBackgroundCheckProvider` supports officer-recorded results; `CheckrBackgroundCheckProvider` is disabled unless platform credentials are explicitly configured and rejects hosts outside Checkr's API allow-list. Its canned response fixture is fictional. `NominatimGeocoder` is optional, caches lookups for 24 hours, limits this process to one request per second, sends a descriptive User-Agent, and accepts only explicitly allow-listed HTTPS hosts. Send facility addresses only, not personal contact details. Display its `© OpenStreetMap contributors` attribution with results. Public Nominatim has per-application capacity limits; use an operator-managed or commercial endpoint for higher production traffic. `NoopGeocoder` is the default when geocoding is not configured.
