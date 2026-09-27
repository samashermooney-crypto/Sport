# Track C — files and adapters
Status: working
Model: GPT-6 Luna
Branch: `track/c-adapters`
Current: Files, email, SMS, and push commits through `73ed80d`; 23 adapter tests and isolated Postgres service/RLS tests pass; committing background-check provider next.
Ready for integration: none yet
Requests to other tracks: A — update `server/src/app.test.ts` migration-count expectation from 10 to 12; merge `sharp` and `web-push` package dependencies; mount `filesModule`, compose its authorization/storage dependencies, and regenerate DB types after migrations 0500–0501; add DECISIONS.md entries for tenant-owned files (`org_id NOT NULL`, preserving the RLS coverage invariant) and separate tracked Resend campaign sender domain (2026-09-26).
Blocked on: Track A app-test ownership request (the full suite still asserts 10 migrations; migrations 0500–0501 bring this branch to 12); app mounting, generated types, and the `sharp`/`web-push` dependency merge are required before integration gates.
Queue notes: 1) Files schema/API/storage and Sharp processor implemented; integration tests pending. 2) Resend/Mailpit/Fake sender, Svix verifier, bilingual auth layout/templates implemented; auth-flow wiring pending Track A. 3) Stripe delegated to Track E. 4) Twilio/preview/fake senders, signed inbound/status callbacks and STOP/START/HELP handling implemented. 5) web-push sender and invalid-subscription signal implemented; package install pending Track A. 6) Manual/Checkr provider and recorded fixture implemented. 7) Nominatim geocoder with fixed allow-listed HTTPS host implemented.
Self-review: org file metadata reads/writes run through withOrg; downloads are permission checked and audited; credentials are excluded from errors/logs; file size and magic bytes are checked; campaign sender domain is isolated from security mail. No spec deviation identified.
