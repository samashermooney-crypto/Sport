# Track SEC — Phase 16 §1 security

Status: ready-for-integration
Branch: `track/sec`

## Ready for integration ranges

- `9b5b430..HEAD` — SEC controls, tests, and security documentation.
- Includes threat model and operator docs; reusable header middleware; encryption-key rotation CLI with isolated Postgres CLI test; SSRF, stored-XSS, upload-bypass, session-fixation, impersonation, and guardian-family isolation tests.
- Existing controls verified alongside SEC tests: auth CSRF/rate limits/MFA, signed Stripe webhooks, guardian Restricted-file ownership, and provider host allowlists.

## Requests to other tracks

- C — mount the new global security-header middleware in `server/src/app.ts` before API and static routes; ensure CSP has the documented Stripe/Turnstile/storage directives and HSTS is production-only. The current app factory sends no global CSP, HSTS, frame, referrer, or permissions headers.
- C — add generated route metadata for every API operation (`permission`, `resource`, `scope`) and publish it to OpenAPI/registry so tenancy fuzzing and permission-matrix completeness can iterate all routes. Current OpenAPI operations have no such metadata.
- C — mount Stripe and Connect webhook routers before JSON parsing so raw signature verification runs on production traffic; keep the existing endpoint-specific signature verification.
- C — add gitleaks to CI and expose the draft `docs/security/security.txt` at `/.well-known/security.txt`; replace its reserved `.example` contact and canonical domain with staffed production values before launch.
- A — regenerate Kysely types after migration `1054_late_fee_fk_index.sql`; `npm run db:migrate` generated `invoice_lines.late_fee_installment_id`, which is currently absent from `server/src/db/types.ts` on `rebuild/trunk`.

## Blocked on

- Global header e2e verification and generated every-route permission/tenancy coverage are blocked on Track C's app/registry wiring. The requested files and current evidence are listed above; the affected browser assertions are committed as `test.fixme` pending that wiring.

## Verification

- `npm run typecheck`, `npm run lint`, and `git diff --check` pass.
- Isolated `athlentry_sec` Vitest security/regression selection: 16 files, 44 tests passed, including the CLI dry-run and apply paths.
- SEC Chromium checks: guardian family-isolation passes; header/route-metadata/matrix/tenancy checks remain `test.fixme` until Track C wiring lands (4 skipped).
