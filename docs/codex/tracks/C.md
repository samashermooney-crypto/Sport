# Track C — files and adapters
Status: working
Model: GPT-6 Luna
Branch: `track/c-adapters`
Current: Files/storage committed as `75db839`; email adapter is next; merge `rebuild/trunk` before database verification.
Ready for integration: none yet
Requests to other tracks: A — merge `sharp` and `web-push` package dependencies; mount `filesModule`, compose its authorization/storage dependencies, and regenerate DB types after migration 0500; add a DECISIONS.md note that Resend campaign tracking uses a separate tracked sender domain while security mail uses an untracked domain (2026-09-26).
Blocked on: merge `rebuild/trunk` before starting the isolated database stack; then run files tenancy/RLS tests with escalated Docker/Postgres access.
Queue notes: 1) Files schema/API/storage and Sharp processor implemented; integration tests pending. 2) Resend/Mailpit/Fake sender, Svix verifier, bilingual auth layout/templates implemented; auth-flow wiring pending Track A. 3) Stripe delegated to Track E. 4) Twilio/preview/fake senders, signed inbound/status callbacks and STOP/START/HELP handling implemented. 5) web-push sender and invalid-subscription signal implemented; package install pending Track A. 6) Manual/Checkr provider and recorded fixture implemented. 7) Nominatim geocoder with fixed allow-listed HTTPS host implemented.
Self-review: org file metadata reads/writes run through withOrg; downloads are permission checked and audited; credentials are excluded from errors/logs; file size and magic bytes are checked; campaign sender domain is isolated from security mail. No spec deviation identified.
