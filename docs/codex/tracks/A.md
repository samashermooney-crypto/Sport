# Track A — core and integration

Status: working
Model: GPT-6 Sol until S1; GPT-6 Luna after S1
Branch: `track/a-core`
Current: Registry checkpoint is on trunk; module generator implemented and in gate verification. Phase 1 tasks 3–5, 6–10, 13–15, 17 remain; preview SMTP offset remains Track C handoff.
Ready for integration: none
Requests to other tracks: C — make `createMailpitEmailSender` use `ATHLENTRY_MAILPIT_SMTP_PORT` (default 1025) so offset Playwright email journeys use their own Mailpit container.
Blocked on: none
Self-review: Server app, worker and configuration consume the generated module/integration registry; web routing consumes generated feature routes.
Self-review: Existing auth routes keep `/api/v1/auth`; full browser sign-up, Mailpit verification, MFA and device journey passes on Chromium and WebKit.
Self-review: Generated errors and permissions are sorted/deduplicated; CI checks all four generated files for freshness. `PORT_OFFSET` SMTP delivery waits on Track C's sender change.
