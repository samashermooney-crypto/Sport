# Track H — communications and chat

Status: ready-for-integration (H slice and merged-tree gates green; Phase 10 acceptance awaits cross-track work)
Branch: `track/h-comms` (local only; no push)
Base: `rebuild/trunk` at `59960a6`, merged locally into this branch
Ready range: `c577d62..HEAD`
Migration range: `4000–4004`

## Delivered

- Campaign APIs and composer for person/team/program/role selectors, registration and payer-only past-due filters, merge fields, English/Spanish variants, test send, scheduling/canceling, statistics and emergency broadcast.
- A read-only draft audience-preview endpoint powers a debounced live recipient count and recipient list before save. Saved and unsaved previews share resolver and channel eligibility rules; emergency preview requires owner/admin access. `campaignPreviewSchema` accepts counts for selected channels only. DEC-054 records this behavior.
- Email/SMS/push/in-app delivery, guardian routing, dedupe, suppression, SMS consent, shared quiet-hours checks, bounded retries and delivery statistics. Signed provider callbacks are processed; Resend delivery correlation still needs the provider IDs returned by Track C's email sender. Development/test sends use fake or preview adapters.
- SMS consent evidence and tokenized email unsubscribe. The portal uses Track B's notification inbox/preferences APIs.
- Team and staff chat with the shared SafeSport policy, guardian inclusion, adult/minor DM safeguards, read receipts, mute, edit/soft delete, moderation, report-to-compliance and Track B SSE integration.
- Person and household communication history APIs and internal attachment references. The console and portal route arrays are now mounted by merged Track A changes; profile-page links and household conversation attachment authorization remain pending.
- Bilingual Phase 10 notification templates are defined and exported in the communications module. Track B's catalog/preference changes are ready on its branch but are not yet in `rebuild/trunk`; H still needs to use those types and the Track B preferences-center link helper after integration.
- Ran `npm run gen:module communications`; it refused to overwrite the existing module. Refreshed generated registries and OpenAPI.

## Verification

- `npm run typecheck` and `npm run lint` — passed after the latest trunk merge.
- Targeted `MessagesConsole` UI test — 1 passed; covers live preview and displayed recipient locale/channels.
- Targeted communications service integration — 4 passed; covers tenant scoping, eligible counts and emergency-role enforcement.
- Full `npm test` on the isolated `COMPOSE_PROJECT_NAME=athlentry_h`, `PORT_OFFSET=800` Postgres stack — 152 files passed, 1 skipped; 570 tests passed, 1 skipped.
- Full `npm run test:e2e` on the isolated stack — 28 passed, 4 skipped across Chromium and WebKit mobile. One initial WebKit parity run failed the 44px control check; that case passed alone and the full rerun passed. The Playwright suite still has no Phase 10 communications/chat journeys.
- `npm run build`, `npm run registry`, `npm run openapi`, `npm run db:migrate`, `npm run db:codegen` and `git diff --check` — passed; codegen introspected 147 tables.
- No live email, SMS or push was sent. No branch was pushed.

## Integration dependencies

- **A — partially integrated:** Route mounting is complete. Still needed: add H history links to person/household profiles; capture consent when a verified phone is entered; expose `programs.settings.communications.athleteChatEnabled`; call H conversation sync after roster, staff, guardian-link and setting changes; add coach-to-16-year-old guardian-copy and other Phase 10 Chromium/WebKit mobile journeys with axe; surface bounce suppressions in Action Center.
- **B — ready on `track/b-logic`, not in trunk:** Commit `5751eb2` adds the 47 Phase 10 notification types and SMS/push preference channels. After it lands, H must send the Phase 10 notification type IDs and use `preferencesCenterPath(orgId)` after tokenized unsubscribe. Ten-minute per-conversation chat batching and unread push/email fallback remain unimplemented.
- **C — ready on `track/c-adapters`, not in trunk:** The branch range `fd229db..0011b8b` returns provider IDs from `EmailSender`; after integration, correlate Resend callbacks to H deliveries. C still needs active same-organization conversation-member authorization for approved chat image/PDF upload and download.
- **G:** Five schedule changes within 15 minutes must become one family communication. No G implementation or track readiness file is present on `rebuild/trunk`.

## Completion boundary

The H slice is ready for integration, but Phase 10 is not complete until the remaining A/B/C/G work lands and the Phase 10 Playwright journeys pass in Chromium and WebKit mobile with axe. `Track H complete` is intentionally not recorded while those acceptance criteria remain outstanding.
