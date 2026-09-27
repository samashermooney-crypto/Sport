# Track C — files and adapters
Status: ready-for-integration
Branch: `track/c-adapters`
Current: Merged `rebuild/trunk` at `fd229db`; completed Track F's restricted-file authorization request and Track H's provider-ID request.
Ready for integration: local commit range `fd229db..0011b8b` (implementation and adapter docs); this final status note is also on the branch. No push. Track A can merge the shared local branch.
Requests to other tracks: A — update DEC-023 in `docs/codex/DECISIONS.md` to reflect the newly authorized verified-guardian restricted uploads and owner/compliance-only restricted downloads; the current decision still says owner/admin downloads.
Blocked on: none for Track C implementation; DEC-023 reconciliation belongs to Track A during integration.

## Requests from SEC

- SEC-001 — mount `server/src/lib/security/security-headers.ts` in `server/src/app.ts` before API and static routes; preserve production-only HSTS and the `/embed/*` framing exception. The app factory currently has no global CSP, HSTS, frame, referrer, or permissions headers (2026-09-27).
- SEC-002 — add generated `permission`, `resource`, and `scope` metadata to every API operation and expose it to OpenAPI/route tests, including fixture hooks for the every-route tenancy fuzz runner. Current OpenAPI operations lack that metadata, so matrix and route coverage cannot prove completeness (2026-09-27).
- SEC-003 — mount Stripe and Connect webhook routers before JSON parsing so signature verification receives raw request bytes; signature unit tests exist but production `app.ts` does not mount them (2026-09-27).
- SEC-004 — add gitleaks to CI and publish `docs/security/security.txt` at `/.well-known/security.txt`; replace its reserved `.example` contact/domain before production (2026-09-27).
Queue notes: 1) Verified linked guardians can upload restricted `person_credential` and `return_to_play_clearance` evidence; owner/compliance roles can download; restricted reads go through the audited API route and return 404 to other readers. 2) Email returns SMTP/Resend IDs; fakes return stable fake IDs; bilingual templates remain available. 3) Stripe belongs to Track E. 4) Twilio, preview and fake SMS return provider IDs; signed inbound/status callbacks and STOP/START/HELP suppression remain supported. 5) Push returns a provider ID when the service response exposes one, preserves invalid-endpoint cleanup and propagates transient errors. 6) Manual/Checkr providers and the recorded fixture are implemented. 7) Nominatim is optional, cached, limited to one request per second per process, privacy-filtered, HTTPS allow-listed, and exposes attribution.
Self-review: file authorization resolves person, credential and return-to-play owners only inside the current org; guardian links must be verified and active; Restricted downloads require an active membership plus an org-level owner or compliance role with MFA complete. Direct object URLs are not issued for Restricted files, so each content read is re-authorized and audited. Email and Twilio IDs map to their delivery webhook IDs; Web Push exposes an ID only when the service supplies one. No real provider keys or messages were used.
Verification: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test` (143 files passed, 1 skipped; 544 tests passed, 1 skipped), and `npm run test:e2e` (26 passed, 4 skipped) passed. Focused provider/files tests passed (20); the file authorization, audit and 404 cases ran against real PostgreSQL. Offset 500 was occupied by Track E on port 5932, so the isolated `athlentry_c` stack used offset 510 (Postgres 5942) without disturbing E.

Track C complete
