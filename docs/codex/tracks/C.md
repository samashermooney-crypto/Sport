# Track C — files and adapters
Status: working
Model: GPT-6 Luna
Branch: `track/c-adapters`
Current: Files/storage committed as `75db839`; email adapter is next; merge `rebuild/trunk` before database verification.
Ready for integration: none yet
Requests to other tracks: A — update `server/src/app.test.ts` migration-count expectation from 10 to 12; merge `sharp` and `web-push` package dependencies; mount `filesModule`, compose its authorization/storage dependencies, and regenerate DB types after migrations 0500–0501; add DECISIONS.md entries for tenant-owned files (`org_id NOT NULL`, preserving the RLS coverage invariant) and separate tracked Resend campaign sender domain (2026-09-26).
Blocked on: Track A app-test ownership request is needed for the full suite; files tenancy/RLS tests now run against isolated Postgres after migrations 0500–0501.
Queue notes: 1) Files schema/API/storage and Sharp processor implemented; integration tests pending. 2) Resend/Mailpit/Fake sender, Svix verifier, bilingual auth layout/templates implemented; auth-flow wiring pending Track A. 3) Stripe delegated to Track E. 4) Twilio/preview/fake senders, signed inbound/status callbacks and STOP/START/HELP handling implemented. 5) web-push sender and invalid-subscription signal implemented; package install pending Track A. 6) Manual/Checkr provider and recorded fixture implemented. 7) Nominatim geocoder with fixed allow-listed HTTPS host implemented.
Self-review: org file metadata reads/writes run through withOrg; downloads are permission checked and audited; credentials are excluded from errors/logs; file size and magic bytes are checked; campaign sender domain is isolated from security mail. No spec deviation identified.
