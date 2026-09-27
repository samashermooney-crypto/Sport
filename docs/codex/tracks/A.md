# Track A — core and integration

Status: working
Model: GPT-6 Sol until S1; GPT-6 Luna after S1
Branch: `track/a-core`
Current: Spine and ready B/C/D ranges are integrated and pushed on `rebuild/trunk`. Track A completed Phase 1 task 6 locally, including authenticated `/start`, the built-in sport catalog, and guarded credential editing and disabling. Next are tasks 3–5, 7–8 and 16–17.
Ready for integration: Track A task 6 onboarding commits after local full gate.
Requests to other tracks: E — proceed with Phase 4 against the spine now on trunk.
Blocked on: none
Self-review: Server app, worker and configuration consume the generated module/integration registry; web routing consumes generated feature routes.
Self-review: Existing auth routes keep `/api/v1/auth`; full browser sign-up, Mailpit verification, MFA and device journey passes on Chromium and WebKit.
Self-review: Generated errors and permissions are sorted/deduplicated; CI checks all four generated files for freshness. Track C's SMTP port offset passes isolated browser tests.
