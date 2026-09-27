# Required Playwright journey audit

Audit snapshot: `track/qa` after merging `rebuild/trunk` at `27c2826`. This is a coverage inventory, not a claim that local Playwright runs passed. At this snapshot all browser verification is blocked by the required QA stack's port collision with Track I; see `docs/codex/tracks/QA.md`.

| # | Journey | Status on the audit snapshot | Browser evidence / remaining acceptance |
|---:|---|---|---|
| 1 | Org sign-up → MFA → invite admin → role change revokes session | Covered | `e2e/sign-in.spec.ts` exercises signup, verification, MFA, org creation, admin invite/acceptance, MFA completion, role change and revoked-session redirect. Local run pending. |
| 2 | Guardian accepts invitation and edits child medical info | Partial | `e2e/guardian-invitation.spec.ts` accepts a verified invitation and checks family access on a phone. Medical editing is not implemented on trunk and is absent from the journey. |
| 3 | Import 2,000 people with preview and rollback | Not available | Phase 2 imports remain open; no import Playwright test exists. |
| 4 | Volleyball season wizard and team generation | Not available | Phase 3 is not started on the audit snapshot; no journey exists. |
| 5 | Season rollover preview and commit | Not available | Phase 3 is not started on the audit snapshot; no journey exists. |
| 6 | Stripe onboarding → first payment → approved partial refund | Partial | `e2e/finance-portal.spec.ts` only checks portal navigation and intercepts payment-method APIs. It does not exercise onboarding, payment, or refund. |
| 7 | Installment autopay, failed retry, card update, success | Not available | Phase 4 acceptance is open; no clock-controlled Playwright journey exists. |
| 8 | Two-child registration, sibling discount, waiver, ACH, bilingual email | Not available | Registration acceptance is open; no end-to-end checkout journey exists. |
| 9 | Returning family re-registers in at most four screens | Not available | Registration acceptance is open; no journey exists. |
| 10 | Waitlist offer and acceptance | Not available | Registration acceptance is open; no journey exists. |
| 11 | External adult captain enters team and invites players | Not available | Registration acceptance is open; no journey exists. |
| 12 | Tryout check-in, offline scoring, team balancing, offers and deposit | Not available | Phase 6 is not started; no journey exists. |
| 13 | Coach compliance gate and activation after approval | Partial | `e2e/safety-integration.spec.ts` covers safety-center routes, not coach gating or credential approval. Phase 7 acceptance remains open. |
| 14 | Concussion report and return-to-play clearance | Not available | Phase 7 acceptance remains open; no browser journey exists. |
| 15 | Schedule generation through publication and family notification | Not available | Track G has no integrated range on the audit snapshot; no journey exists. |
| 16 | Rainout, notifications and approved reschedule request | Not available | Track G has no integrated range on the audit snapshot; no journey exists. |
| 17 | Offline game day: attendance, lineup warning, score and sync | Not available | Track G has no integrated range on the audit snapshot; no journey exists. |
| 18 | Double-elimination tournament with external teams | Not available | Track G has no integrated range on the audit snapshot; no journey exists. |
| 19 | Swim meet results and team scoring | Not available | Track G has no integrated range on the audit snapshot; no journey exists. |
| 20 | Officials assignment, decline, reassign and pay batch | Not available | Track G has no integrated range on the audit snapshot; no journey exists. |
| 21 | Bilingual campaign with quiet hours and unsubscribe | Partial | `e2e/communications.spec.ts` covers a bilingual draft, preview, test send and schedule cancellation. It does not cover quiet-hour deferral or tokenized unsubscribe in the browser. H integration tests cover those services. |
| 22 | Team chat with SafeSport guardian inclusion | Added; execution pending | `e2e/journeys/chat-safesport.spec.ts` opens a minor's team chat as staff, asserts the guardian-included label, then checks the guardian can read and reply at phone width. Local run pending. |
| 23 | Volunteer shift signup, check-in and buyout | Not available | Phase 11 work is not integrated; no journey exists. |
| 24 | Academy tuition, proration, make-up class and promotion | Not available | Phase 12 work is not integrated; no journey exists. |
| 25 | Federation entries, shared-field schedule, results and standings | Not available | Phase 13 work is not integrated; no journey exists. |
| 26 | Report builder, schedule and privacy deletion | Not available | Phase 14 work is not integrated; no journey exists. |
| 27 | New organization onboarding checklist | Not available | Phase 15 work is not integrated; no journey exists. |

## Execution status

- `e2e/crawler/routes.spec.ts` now discovers destinations from rendered navigation for anonymous, organization, family and platform roles. It checks route responses, settled same-origin API responses, page/console errors and axe, and fails rather than silently truncating the crawl.
- Crawler and new journey specs type-check and lint. Required browser verification remains pending until the QA stack can bind Postgres port `6932` without stopping another track's services.
- “Not available” means the feature is not on this merged trunk snapshot, not that a failing browser assertion is being suppressed.
