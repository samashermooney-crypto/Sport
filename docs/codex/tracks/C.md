# Track C — files and adapters
Status: working
Model: GPT-6 Luna
Branch: `track/c-adapters`
Current: Provider implementations and registry descriptors are committed through `0d6186f`; geocoder implementation passed focused lint/typecheck; final gates in progress.
Ready for integration: none yet
Requests to other tracks: A — update `server/src/app.test.ts` migration-count expectation from 10 to 12; merge `sharp` and `web-push` dependencies; compose/mount `filesModule` routes and regenerate DB types after migrations 0500–0501; add DECISIONS.md entries for tenant-owned files (`org_id NOT NULL`, preserving the RLS coverage invariant) and separate tracked Resend campaign sender domain (2026-09-26).
Blocked on: Track A app-test ownership request; full suite has that one migration-count failure. App mounting, generated types, and the `sharp`/`web-push` dependency merge remain integration requirements.
Queue notes: 1) Files migration/API/S3, local and memory storage, Sharp processor, and Postgres tenancy/audit tests implemented; mount and package wiring pending A. 2) Resend/Mailpit/Fake, Svix verifier, Mailpit port env, and bilingual auth templates implemented; auth-flow wiring pending A. 3) Stripe delegated to Track E. 4) Twilio/preview/fake, signed callbacks, required status callback URL, and STOP/START/HELP suppression boundary implemented. 5) web-push sender/factory and invalid-endpoint cleanup callback implemented; package merge pending A. 6) Manual/Checkr and recorded fixture implemented. 7) Nominatim geocoder caches results, limits this process to 1 request/s, rejects contact details, uses an explicit HTTPS host allow-list, and exposes attribution.
Self-review: org file metadata reads/writes run through withOrg; downloads are permission checked and audited; credentials are excluded from errors/logs; file size and magic bytes are checked; campaign sender domain is isolated from security mail. No spec deviation identified.
