# Track A — core and integration

Status: working
Model: GPT-6 Sol until S1; GPT-6 Luna after S1
Branch: `track/a-core`
Current: Schema spine migrations 0100–0113, shared entity contracts, Kysely types, test factories, and split-space booking are locally green and ready for trunk integration. Then merge ready B/C/D ranges and resume remaining Phase 1 work.
Ready for integration: schema spine and factories from the next Track A commit; B complete queue, C adapters, and D primitives are also marked ready in their local track files.
Requests to other tracks: E — begin Phase 4 once the spine lands on `rebuild/trunk`.
Blocked on: none
Self-review: Server app, worker and configuration consume the generated module/integration registry; web routing consumes generated feature routes.
Self-review: Existing auth routes keep `/api/v1/auth`; full browser sign-up, Mailpit verification, MFA and device journey passes on Chromium and WebKit.
Self-review: Generated errors and permissions are sorted/deduplicated; CI checks all four generated files for freshness. `PORT_OFFSET` SMTP delivery waits on Track C's sender change.
