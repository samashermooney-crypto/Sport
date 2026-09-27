# Track A — core and integration

Status: working
Model: GPT-6 Sol until S1; GPT-6 Luna after S1
Branch: `track/a-core`
Current: Spine, ready B/C/D/E/H ranges, task 6 onboarding, E finance and checkout core through unique invoice binding, and Track B's platform/notification range are integrated on `rebuild/trunk`. Phase 1 tasks 5–9, 11–13 and 17 are complete. A GPS-tagged fixture verifies EXIF removal for image and document photos. Track H's communications/chat slice is mounted and green, with Phase 10 cross-track acceptance open. Task 12's bilingual HTML/text auth, invitation and security mail is wired through Mailpit with recipient locale and org branding. Task 16 has a tenant-scoped organization switcher, permission-filtered Home, app error boundary, live toast delivery and bilingual sign-in, sign-up, recovery, token and MFA screens; its latest A gate passed 564 tests and 28 browser tests. Account-security settings, legal text, portal/public locales, app-wide shells and remaining design acceptance remain. Task 4 remains open for a trusted HTTPS native browser push subscription. Track F's ready Phase 7 merge was aborted on red OpenAPI contracts, an unhandled expiry job and unmounted web routes; revisit F only after those contracts can pass the gate.
Ready for integration: Account-specific organization list, tenant-scoped workspace summary, role-filtered console cards and multi-org switcher with Chromium/WebKit accessibility journeys. Track A passed typecheck, lint, 448 tests (one operator smoke skipped), 24 browser tests (4 guarded design skips), build, registry/OpenAPI freshness and Knip; the merged full gate follows. Task 4 remains open for a real trusted HTTPS browser subscription check.
Requests to other tracks: E — proceed with Phase 4 against the spine now on trunk.
Requests to other tracks: D — identity screens in task 3 are stable for your auth restyle queue; console Home in task 17 remains with A.
Blocked on: none
Self-review: Server app, worker and configuration consume the generated module/integration registry; web routing consumes generated feature routes.
Self-review: Existing auth routes keep `/api/v1/auth`; full browser sign-up, Mailpit verification, MFA and device journey passes on Chromium and WebKit.
Self-review: Generated errors and permissions are sorted/deduplicated; CI checks all four generated files for freshness. Track C's SMTP port offset passes isolated browser tests.
