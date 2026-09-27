# Required Playwright journey audit

Audit snapshot: `track/qa` synced through `rebuild/trunk` at `d038556`. This is a coverage inventory, not a claim that local Playwright runs passed. Browser verification is blocked by the required QA stack's port collision with Track I; see `docs/codex/tracks/QA.md`.

| # | Journey | Status on the audit snapshot | Browser evidence / remaining acceptance |
|---:|---|---|---|
| 1 | Org sign-up → MFA → invite admin → role change revokes session | Covered | `e2e/sign-in.spec.ts` exercises signup, verification, MFA, org creation, admin invite/acceptance, MFA completion, role change and revoked-session redirect. Local run pending. |
| 2 | Guardian accepts invitation and edits child medical info | Added; execution pending | `e2e/guardian-invitation.spec.ts` now verifies saved allergy/medication values after reload; `e2e/security/guardian-idor.spec.ts` asserts a different guardian receives 404 for the child's medical profile. |
| 3 | Import 2,000 people with preview and rollback | Added; execution pending | `e2e/journeys/import-scale.spec.ts` previews, commits and rolls back a 2,000-person batch, then verifies all imported records are archived. |
| 4 | Volleyball season wizard and team generation | Not covered | No Playwright acceptance flow for the season wizard and team generation is present in `e2e/`. |
| 5 | Season rollover preview and commit | Not covered | No Playwright acceptance flow for rollover preview and commit is present in `e2e/`. |
| 6 | Stripe onboarding → first payment → approved partial refund | Partial | `e2e/finance-portal.spec.ts` only checks portal navigation and intercepts payment-method APIs. It does not exercise onboarding, payment, or refund. |
| 7 | Installment autopay, failed retry, card update, success | Not available | Phase 4 acceptance is open; no clock-controlled Playwright journey exists. |
| 8 | Two-child registration, sibling discount, waiver, ACH, bilingual email | Not available | Registration acceptance is open; no end-to-end checkout journey exists. |
| 9 | Returning family re-registers in at most four screens | Not available | Registration acceptance is open; no journey exists. |
| 10 | Waitlist offer and acceptance | Not available | Registration acceptance is open; no journey exists. |
| 11 | External adult captain enters team and invites players | Not available | Registration acceptance is open; no journey exists. |
| 12 | Tryout check-in, offline scoring, team balancing, offers and deposit | Not available | Phase 6 is not started; no journey exists. |
| 13 | Coach compliance gate and activation after approval | Partial | `e2e/safety-integration.spec.ts` covers safety-center routes, not coach gating or credential approval. Phase 7 acceptance remains open. |
| 14 | Concussion report and return-to-play clearance | Not available | Phase 7 acceptance remains open; no browser journey exists. |
| 15 | Schedule generation through publication and family notification | Not covered | No Playwright flow exercises generator review/apply, publication and family notification. |
| 16 | Rainout, notifications and approved reschedule request | Partial | `e2e/schedule-stats.spec.ts` closes a facility and asserts an affected event is postponed; it does not verify notification delivery or an approved reschedule request. |
| 17 | Offline game day: attendance, lineup warning, score and sync | Partial | `e2e/schedule-offline.spec.ts` syncs attendance and surfaces a concurrent score conflict; it does not cover a lineup warning or successful score sync. |
| 18 | Double-elimination tournament with external teams | Not covered | `server/src/modules/tournaments/bracket-acceptance.test.ts` covers bracket logic; no browser journey exercises external team entry through the final. |
| 19 | Swim meet results and team scoring | Not covered | `server/src/modules/contests/meet.integration.test.ts` covers meet results; no browser journey exercises result entry and team scoring. |
| 20 | Officials assignment, decline, reassign and pay batch | Not covered | The service integration tests cover assignments and pay batches; no browser journey exercises the required staff/official workflow. |
| 21 | Bilingual campaign with quiet hours and unsubscribe | Partial | `e2e/communications.spec.ts` covers a bilingual draft, preview, test send and schedule cancellation. It does not cover quiet-hour deferral or tokenized unsubscribe in the browser. H integration tests cover those services. |
| 22 | Team chat with SafeSport guardian inclusion | Added; execution pending | `e2e/journeys/chat-safesport.spec.ts` opens a minor's team chat as staff, asserts the guardian-included label, then checks the guardian can read and reply at phone width. Local run pending. |
| 23 | Volunteer shift signup, check-in and buyout | Not available | Phase 11 work is not integrated; no journey exists. |
| 24 | Academy tuition, proration, make-up class and promotion | Partial | `e2e/classes.spec.ts` covers attendance-issued make-up credit and booking; monthly tuition/proration and level promotion are not covered in a browser. |
| 25 | Federation entries, shared-field schedule, results and standings | Not available | Phase 13 work is not integrated; no journey exists. |
| 26 | Report builder, schedule and privacy deletion | Not available | Phase 14 work is not integrated; no journey exists. |
| 27 | New organization onboarding checklist | Not available | Phase 15 work is not integrated; no journey exists. |

## Execution status

- `e2e/crawler/routes.spec.ts` discovers destinations from rendered navigation for anonymous, organization, family and platform roles. It checks route responses, settled same-origin API responses, page/console errors and axe, and fails rather than silently truncating the crawl.
- Crawler and journey specs type-check and lint. Required browser verification remains pending until the QA stack can bind Postgres port `6932` without stopping another track's services.
- “Not covered” means no browser flow for that required acceptance path was found; service or integration tests do not count as the required Playwright journey. Browser tests are still unverified on this snapshot.
