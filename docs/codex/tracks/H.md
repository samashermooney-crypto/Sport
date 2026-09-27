# Track H — communications and chat

Status: ready-for-integration (H slice green; Phase 10 acceptance remains blocked on A/B/C/G integration)
Branch: `track/h-comms` (local only; no push)
Base: `rebuild/trunk` at `82b9cb0`, merged by `c621562`
Ready range: `c621562..HEAD`
Migration range: `4000–4004`

## Delivered

- Campaign APIs and composer for person/team/program/role targeting, registration and payer-only past-due filters, merge fields, English/Spanish content, test send, schedule/cancel, delivery statistics and emergency broadcasts.
- Live unsaved-audience preview uses the same recipient and channel-eligibility calculation as saved campaign preview. Emergency preview requires owner/admin authorization. DEC-048 records this behavior.
- Email/SMS/push/in-app delivery wiring, dedupe, guardian routing, suppression, consent, shared quiet-hours checks, bounded retries, provider callbacks and campaign statistics. Development and test sends use fake/preview adapters.
- SMS consent evidence and tokenized email unsubscribe. The portal uses Track B's notification inbox and preferences APIs rather than duplicating them.
- Team and staff chat with the shared SafeSport policy, guardian inclusion, minor DM restrictions, read receipts, mute, edit/soft delete, moderation and report-to-compliance. SSE events use Track B's service.
- Person and household communication history APIs and internal attachment references. Family-only attachment actions remain unavailable under the current Track C Files authorization.
- Bilingual Phase 10 notification templates are defined and exported in the communications module descriptor; Track B's static catalog does not yet register them.
- Ran `npm run gen:module communications`; it refused to overwrite the existing module. Refreshed registries and OpenAPI through their generators.

## Verification

- `npm run typecheck` — passed.
- `npm run lint` — passed.
- Targeted `MessagesConsole` UI test — 1 passed; verifies selector changes call the live preview and display recipient locale/channels.
- Targeted communications service integration — 4 passed, including cross-tenant preview scoping and emergency-role enforcement.
- Full `npm test` on the isolated `COMPOSE_PROJECT_NAME=athlentry_h`, `PORT_OFFSET=800` Postgres stack — 149 files passed, 1 skipped; 563 tests passed, 1 skipped.
- Full `npm run test:e2e` on the isolated stack — 26 passed, 4 skipped. The existing sign-in journey had one parallel-run locator failure and passed alone and on the full rerun. No Phase 10 message/chat journeys are currently in the Playwright suite.
- `npm run build`, `npm run registry`, `npm run openapi` and `git diff --check` — passed.
- No live email, SMS or push was sent. No branch was pushed.

## Integration dependencies

- **A:** Mount H's console and portal route arrays in the runtime router; add person/household history to profile screens; capture SMS consent when a verified phone is entered; expose `programs.settings.communications.athleteChatEnabled`; invoke H team/staff conversation synchronization after roster, staff, guardian-link and setting changes; add the Phase 10 Chromium and WebKit mobile Playwright journeys with axe, including coach-to-16-year-old guardian copies; surface bounce suppressions in Action Center.
- **B:** Register H's en/es Phase 10 notification catalog entries with the notification types, category, default channel and preference metadata; expose SMS/push preferences; implement 10-minute per-conversation chat batching and unread push/email fallback using preferences. Track B currently recognizes only its generic Phase 1 catalog and `in_app`/`email` preference channels.
- **C:** Return provider IDs from `EmailSender` and persist Resend IDs so signed delivery webhooks correlate to H deliveries. Extend Files upload/download authorization to active same-organization conversation members for approved chat image/PDF attachments.
- **G:** Batch five schedule changes within 15 minutes into one family communication.

## Completion boundary

The H-owned slice is ready for integration, but Phase 10 is not complete until the integration dependencies above land and the Phase 10 browser journeys pass in Chromium and WebKit mobile with axe. The current full browser gate covers other product areas only.
