# Track H — communications and chat

Status: ready-for-integration (H-owned slice and live draft audience preview; Phase 10 completion awaits cross-track work)
Branch: `track/h-comms` (local only; no push)
Base: merged `rebuild/trunk` at `8553f4b` before this task; prior H checkpoint `a9d9916`
Local branch range: `a9d9916..HEAD` (includes the `8553f4b` trunk merge and this readiness commit)
Migration range: `4000–4004`

## Delivered

- Campaign API and console composer: people/team/program/role selectors plus registration-status and payer-only past-due filters; en/es copy, merge fields, audience preview, test send, schedule/cancel and emergency broadcast.
- Delivery worker: in-app/email/SMS/push adapter wiring, idempotent delivery rows, guardian routing, suppression and consent enforcement, shared quiet-hours policy, bounded retry/backoff, provider webhook status handling and stats.
- SMS: append-only consent UI/API evidence, verified Twilio STOP/START/HELP handling and global STOP suppression; development/test senders remain preview/fake.
- Chat: shared SafeSport checks, guardian inclusion, no unguarded adult-minor direct conversation, read-only announcements, opt-in athlete accounts, soft membership revocation, moderation/report-to-compliance, Track B notification/SSE integration, and household history API.
- Attachments: completed internal image/PDF references are tenant-validated and stored on messages; portal actions follow current Files authorization. Family-only file access remains blocked by Track C authorization and is listed below.
- Preferences: H keeps SMS consent and tokenized email unsubscribe; portal links to Track B's notification inbox/preferences instead of duplicating those controls.
- Decisions recorded: `DEC-046` through `DEC-051`; schema indexes added in `4004` after the full gate found missing foreign-key lookup indexes.
- The ready `1912463` commit adds a live unsaved-audience preview backed by the saved recipient resolver and channel-eligibility rules, with emergency owner/admin authorization; the decision is recorded as `DEC-054` on trunk.
- Generator requirement: ran `npm run gen:module communications`; it refused to overwrite the existing module, so existing module patterns were preserved.

## Verification

- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm test` on isolated `COMPOSE_PROJECT_NAME=athlentry_h`, `PORT_OFFSET=800` — 113 files passed, 1 skipped; 459 tests passed, 1 skipped.
- `npm run test:e2e` on the isolated stack — 13 passed, 3 skipped; current suite has no Phase 10 chat/comms journeys.
- `npm run build` — passed.
- `npm run registry`, `npm run openapi`, `npm run db:migrate` and `npm run db:codegen` — passed; `git diff --check` — passed before final commit.
- Targeted communications, delivery and chat integration tests passed; all outbound test sends use fake/preview adapters.

## Cross-track integration requests

- A: mount both H route arrays; embed person/household history in profile pages; add verified-phone SMS-consent capture; expose `programs.settings.communications.athleteChatEnabled`; call H team/staff conversation sync after roster, staff, guardian-link and setting changes; add Phase 10 Playwright Chromium + WebKit mobile + axe journeys.
- B: register Phase 10 notification types/templates in en/es in the notification catalog and expose channel/preference metadata for SMS/push; add ten-minute chat notification batching with unread push/email fallback using preferences.
- C: make `EmailSender` return provider IDs and correlate signed Resend events to H delivery rows; extend Files authorization to active same-organization conversation members for approved chat images/PDFs so family accounts can upload/download attachments.
- G: batch five schedule changes within 15 minutes into one family communication.

## Completion boundary

- H-owned implementation and full repository gates are ready for integration, but Phase 10 acceptance is not complete until the cross-track requests above land and the H journeys run in Chromium and WebKit mobile with axe.
- No real email, SMS or push was sent; no branch was pushed.
