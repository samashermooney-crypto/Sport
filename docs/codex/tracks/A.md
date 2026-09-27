# Track A — core and integration

Status: working
Model: GPT-6 Sol until S1; GPT-6 Luna after S1
Branch: `track/a-core`
Current: Spine and ready B/C/D ranges are integrated and pushed on `rebuild/trunk`. Track A is finishing Phase 1 tasks 3–8 and 16–17. Authenticated `/start` and the built-in sport catalog are locally green; task 6 still needs credential editing and disabling.
Ready for integration: `/start` onboarding milestone after its Track A commit.
Requests to other tracks: E — proceed with Phase 4 against the spine now on trunk.
Blocked on: none
Self-review: Server app, worker and configuration consume the generated module/integration registry; web routing consumes generated feature routes.
Self-review: Existing auth routes keep `/api/v1/auth`; full browser sign-up, Mailpit verification, MFA and device journey passes on Chromium and WebKit.
Self-review: Generated errors and permissions are sorted/deduplicated; CI checks all four generated files for freshness. Track C's SMTP port offset passes isolated browser tests.
