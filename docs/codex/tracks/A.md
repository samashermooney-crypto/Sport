# Track A — core and integration

Status: working
Model: GPT-6 Sol until S1; GPT-6 Luna after S1
Branch: `track/a-core`
Current: Spine, ready B/C/D ranges, task 6 onboarding, ready E finance contracts and Track B's platform/notification range are integrated and pushed on `rebuild/trunk`. Phase 1 task 9 has a guarded, audited tenant impersonation flow. Task 13 now has account/organization API aliases and the mounted portal journey. Task 7 has versioned role changes, concurrent last-owner guard, scoped invitations and the two-browser admin acceptance journey. Suspension/removal, transfer and scoped-role editing remain alongside tasks 4–5, 8 and 16–17.
Ready for integration: Notification account/organization aliases and portal browser journey after the combined full gate. Task 4 remains open for a real trusted HTTPS browser subscription check.
Requests to other tracks: E — proceed with Phase 4 against the spine now on trunk.
Requests to other tracks: D — identity screens in task 3 are stable for your auth restyle queue; console Home in task 17 remains with A.
Blocked on: none
Self-review: Server app, worker and configuration consume the generated module/integration registry; web routing consumes generated feature routes.
Self-review: Existing auth routes keep `/api/v1/auth`; full browser sign-up, Mailpit verification, MFA and device journey passes on Chromium and WebKit.
Self-review: Generated errors and permissions are sorted/deduplicated; CI checks all four generated files for freshness. Track C's SMTP port offset passes isolated browser tests.
