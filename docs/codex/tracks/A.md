# Track A — core and integration

Status: working
Model: GPT-6 Sol until S1; GPT-6 Luna after S1
Branch: `track/a-core`
Current: Spine, ready B/C/D ranges, task 6 onboarding, ready E finance contracts and Track B's platform/notification range are integrated and pushed on `rebuild/trunk`. Phase 1 tasks 5–9, 13 and 17 are complete. Task 4 remains open for a trusted HTTPS native browser push subscription; task 16 remains. Track F's ready Phase 7 merge was aborted on red generated OpenAPI, an unhandled expiry job and unmounted web routes; revisit after the integration gaps are fixed.
Ready for integration: Console Home with four working owner actions, owner onboarding link and Chromium/WebKit mobile accessibility journeys, pending merged full gate. Task 4 remains open for a real trusted HTTPS browser subscription check.
Requests to other tracks: E — proceed with Phase 4 against the spine now on trunk.
Requests to other tracks: D — identity screens in task 3 are stable for your auth restyle queue; console Home in task 17 remains with A.
Blocked on: none
Self-review: Server app, worker and configuration consume the generated module/integration registry; web routing consumes generated feature routes.
Self-review: Existing auth routes keep `/api/v1/auth`; full browser sign-up, Mailpit verification, MFA and device journey passes on Chromium and WebKit.
Self-review: Generated errors and permissions are sorted/deduplicated; CI checks all four generated files for freshness. Track C's SMTP port offset passes isolated browser tests.
