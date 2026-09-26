# 11 — Phases 3–9: Core Operations

---

## Phase 3 — Sport engine, seasons, programs, divisions, offerings, teams, rosters, facilities

### Tasks
1. Implement `shared/src/sport/*` fully per `03`: schemas, all templates in `03 §6`, age/eligibility, result validation/computation, standings (algorithm in `20 §7`), stats aggregation. 100% line coverage for this folder.
2. Sport profiles UI: browse templates, clone into org, edit all sections (terms, formats, positions, roster, stats, age groups, durations, officials, rubric, uniforms, standings defaults, skill levels, discipline types), versioning notice when results exist.
3. Seasons CRUD with status lifecycle; **Season rollover**: "Copy season" copies programs, divisions, offerings (prices, pricing rules), forms/waiver references, team identities (team_seasons created in `forming` status for teams marked "returning"), staff (as `pending_compliance` re-validation), allocations, volunteer requirements; shifts all dates by an offset or maps to new dates; never copies registrations, money or results. Preview diff before commit.
4. Program wizard and full program settings (`05 §6`) for all modes. Division generator from age method (e.g. U6–U14 × boys/girls/coed). Offerings with pricing config (installment templates reference Phase 4 tables—create template CRUD here, charging comes in Phase 4).
5. Teams (persistent) and team seasons: create manually or "generate N teams per division" with naming patterns; roster management (add/remove/move, jersey numbers with uniqueness and sport range, positions from profile, guest players with limits, roster lock), roster print view and CSV export, team staff assignment (activation gated by Phase 7 compliance — until Phase 7 lands, record status `pending_compliance` and activate only when no requirements are configured).
6. Facilities and spaces with split-field hierarchy, availability windows (RRULE editor UI with common presets: "Weekdays 5–9pm", "Saturdays 8am–6pm"), blackouts, suitability, map link/geocode optional, public visibility.
7. Program public pages data (catalog API) — rendered in Phase 5 (portal) and Phase 14 (site).

### Acceptance criteria
- Templates: property-based tests (fast-check) for age/grade computation around cutoffs and leap days; result computations for every format with edge cases (ties, forfeits, deciding sets, DQ, dropped judges).
- Season rollover of the seeded soccer league produces an identical structure for the next season with shifted dates, zero registrations/money copied, returning teams in `forming`, staff pending re-validation; running it twice with the same idempotency key yields one copy.
- Division generator creates the expected divisions for soccer (birth year, U6–U14 boys/girls = 18 divisions) and basketball (grades 3–8 boys/girls = 12).
- Jersey uniqueness enforced at DB level under concurrent writes.
- Split-field test: booking the full field blocks both halves and vice versa (DB exclusion constraint).
- Playwright: admin creates a volleyball club season via wizard with 3 divisions, 2 offerings, installment template, and generates teams; axe passes; works at 390 px.

---

## Phase 4 — Payments and finance engine (Stripe Connect, test mode)

Read `20 §1–§5` and §10 before starting. Every money-changing operation is transactional, idempotent, audited and covered by a reconciliation test.

### Tasks
1. Stripe Connect onboarding: create Express account (`controller`-based parameters equivalent to Express: Stripe-hosted onboarding, Express dashboard), account links for onboarding/update, return/refresh pages, `account.updated` webhook sync into `payment_accounts`, requirements surfaced in Action Center, login link to Express dashboard for owners/finance. Registration offerings with price > 0 cannot open until `charges_enabled`.
2. Webhooks: two endpoints (platform + Connect), signature verification with raw body, store in `stripe_events` (dedupe by event id), enqueue `stripe.event`, handler per type: `payment_intent.succeeded|processing|payment_failed|canceled|requires_action`, `charge.refunded`, `charge.refund.updated`, `charge.dispute.created|updated|closed|funds_withdrawn|funds_reinstated`, `setup_intent.succeeded`, `payment_method.detached`, `account.updated`, `payout.created|paid|failed` (connected), `customer.subscription.*` and `invoice.*` (platform billing). Handlers are idempotent and order-independent (fetch the latest object from Stripe when state matters).
3. Payer profiles: create platform Customer per account lazily; saved payment methods via SetupIntent (card, us_bank_account with Financial Connections instant verification + microdeposit fallback), list/set default/remove in `/me/payments`.
4. Invoices: create from checkout (Phase 5), staff-created invoices (any lines), team fee assessments, adjustments, void (only when no successful payments, or after full refund), status machine (`20 §4`), numbering, PDF invoice and receipt rendering, emails.
5. Payment collection: PaymentIntent creation with `on_behalf_of`, `transfer_data.destination`, `application_fee_amount` (from org plan/fee settings, `20 §3`), `setup_future_usage` when autopay chosen, metadata (org, invoice, checkout ids), statement descriptor suffix; Payment Element with Apple Pay/Google Pay/Link/ACH; 3DS handling; ACH `processing` state shown honestly (registration becomes `confirmed` only per org setting: `confirmOnAchProcessing` default true with the invoice remaining `processing` until success; failure reverts per `20 §5`).
6. Offline payments (cash/check/external) recorded by finance staff with reference, receipt number, allocation.
7. Installments and autopay: plan selection at checkout, schedule generation (`20 §3`), autopay authorization capture (mandate text versioned), `installments.charge` job with dunning (`20 §5`), manual "pay installment now" for families, staff actions (change due date, split, waive with reason, switch payment method on behalf with family consent recorded).
8. Refunds: full/partial by line, to original method (Stripe refund with `reverse_transfer: true`; `refund_application_fee` per org plan setting, default true), or as account credit; approval threshold (org setting; above threshold requires a second finance/owner approval); refund of ACH that is still processing is blocked with explanation; family and staff notifications; invoice and registration effects per `20 §4`.
9. Disputes: record, Action Center card, evidence packet builder (registration record, signed waiver PDF, refund policy acceptance, attendance, communications) submitted via Stripe API, outcome tracking; debit of connected account through transfer reversal handled per `20 §10`.
10. Credits ledger: issue, apply to invoices, expire, reverse; balance display in portal.
11. Discount codes (port) and automatic discount rules (sibling, multi-program, returning, staff child) with deterministic application order (`20 §2`).
12. Financial aid: program setup, family application form (with document upload), review queue, award (percent/fixed) applied as `aid` lines to existing or future invoices of the household in that season, budget tracking, confidentiality.
13. Service fee pass-through (D8) configuration and computation; displayed as a separate line; appears on receipts.
14. Payouts and reconciliation: sync payouts and balance transactions for connected accounts, reconciliation report (payout → charges/refunds/fees/disputes → invoices), export CSV; accounting export: journal-entry CSV by GL code per day/payout (QuickBooks Online import-compatible columns: Date, Journal No, Account, Debits, Credits, Description, Name, Class).
15. Platform billing: plans, Stripe Billing Checkout for subscription, customer portal link, webhook sync, plan change effects on fees (applies to new charges only).
16. Tax rates for products; sales tax lines on product orders only.
17. Family money UI in portal: balances across orgs, pay now (select invoices/installments), autopay management, receipts, year-end statement per org (payments and donations by tax year).

### Acceptance criteria
- Against stripe-mock + recorded webhook fixtures: full lifecycle tests for card success, 3DS, card failure, ACH processing→success, ACH processing→failure, partial refund by line, refund as credit, dispute created→lost, installment schedule with 2 failures then success, autopay revoked mid-plan, void rules.
- **Reconciliation invariant test** (property-based): random sequences of charges, partial payments, refunds, credits, discounts and voids always satisfy `20 §4` invariants; sum of allocations == succeeded payments; invoice status matches balances.
- Idempotency: double-submitting the same checkout payment never creates two PaymentIntents; replaying every webhook twice changes nothing.
- Service fee: identical for card and ACH; shown before payment; proportional refund; org nets base price when pass-through is on (±1¢ rounding documented in `20 §3`).
- Application fee equals plan settings on every PaymentIntent (asserted in tests).
- With real Stripe **test** keys configured locally, a manual smoke script `scripts/stripe-smoke.ts` onboards a test Express account (using Stripe's test onboarding values), charges test card `4242…`, refunds partially, and prints the reconciliation — documented in `40`.
- Playwright (stripe-mock or test keys): family pays a 3-installment plan with autopay; finance issues a partial refund with approval; family sees updated balance and receipt.

---

## Phase 5 — Registration (individual, team entry, waitlists, approvals, transfers, cancellations)

### Tasks
1. Public/portal program discovery: org program catalog with filters (sport, age/grade computed for the family's kids — "Show programs Maya is eligible for"), program detail pages, share links, registration status (opens in N days / open / closing soon / full — join waitlist / closed).
2. Checkout (`05 §6`): multi-participant, multi-program cart, eligibility engine with reasons, capacity holds (`20 §2`), per-participant forms with answer reuse, waivers, add-ons with sizes (uniform kits), volunteer commitment or buyout (Phase 11 completes volunteer tracking; buyout line is created here if a requirement is configured), discounts (codes + automatic), aid auto-application, service fee, payment plan choice, payment (Phase 4), confirmation page/email with calendar links and next steps. Guest start with account creation at the participant step (Turnstile). Resume open checkout from any device.
3. Returning fast path: "Register again" on last season's registrations pre-selects participant, suggested program by age progression, pre-fills everything valid.
4. Staff registration: register on behalf of a family (with option to send the family a payment link / waiver signing link instead of collecting in person), paper waiver recording, eligibility override with reason, price override with reason.
5. Approvals queue (for offerings requiring approval): approve/decline with message; payment captured on approval (PaymentIntent confirmed with saved method, or payment link sent) — never charge before approval unless org setting "charge at submission, refund on decline".
6. Waitlists (`20 §12`): join (no charge), position visible to family, auto or manual offers, offer expiry, accept → checkout with reserved seat, decline, expiry → next.
7. Cancellations/withdrawals: family-initiated (if org allows before a date) and staff-initiated; refund policy engine (org-level policy with rules by date: full refund before X, Y% before Z, none after; per-program override) proposes refund amounts that finance/registrar can accept or adjust; roster removal; capacity release → waitlist advance.
8. Transfers between programs/divisions/offerings with price difference handling (`transfers.financial_treatment`) — port legacy transactional rules (required destination forms/waivers, idempotent retries, result lookup).
9. Team entries: team registration into league/tournament programs (internal team_season or external team with captain/contact), roster submission deadlines, team fee (fixed or per player), captain invites players to join a team's roster (adult leagues) with each player completing their own waiver/form (and paying if per-player), approval by org, seeding hints.
10. Registration reports and lists: by program/division/offering/status; CSV export; registration pace chart vs last season (same weekday offset).
11. Registration emails/notifications: confirmation, waitlist joined, offer, offer expiring (6 h before), approval/decline, cancellation, transfer, incomplete checkout reminder (after 24 h, once).
12. Uniform size report per team/division/program from add-on lines.

### Acceptance criteria
- **Oversell test**: 300 concurrent checkouts for an offering with capacity 100 → exactly 100 confirmed, 200 either waitlisted or rejected with `CAPACITY_FULL`, zero oversell, holds released on expiry (k6 or Vitest concurrency harness against real Postgres).
- Eligibility tests for every reason code; staff override audited.
- Returning family e2e: parent with 2 returning kids re-registers both in ≤ 4 screens and ≤ 2 minutes of scripted interaction (Playwright step count asserted), paying with saved card.
- New family e2e on 390 px: create account, add 2 children, register both in a soccer program with sibling discount, sign waiver, choose 3-installment plan, pay with ACH (mock), receive confirmation email in Mailpit (en) — then the same flow in Spanish.
- Waitlist e2e: capacity full → join waitlist → staff cancels a registration → offer sent → family accepts within window → confirmed; expired offer advances queue.
- Transfer with price difference charges or refunds correctly and keeps source evidence.
- Team entry e2e: external adult team captain registers team, invites 8 players, players complete waivers, org approves.

---

## Phase 6 — Evaluations (tryouts) and team formation

### Tasks
1. Evaluation event setup: tied to a tryout program (registration with optional fee), target program, rubric from sport profile (editable, weights, position-specific criteria), normalization option, sessions (calendar events), group assignment (by age/gender/position), bib assignment (auto sequential by group; printable bib sheet and check-in list).
2. Check-in UI (tablet/phone): search/scan (QR from confirmation email), assign/confirm bib, photo capture (optional, media consent), late registrants handled via staff registration.
3. Evaluator scoring UI (phone-first, offline-capable): list of athletes by bib with photo, quick score entry per criterion (large tap targets, swipe to next), notes, progress indicator, conflict-free offline sync (per-score upsert with `client_mutation_id`). Evaluators see no contact info.
4. Results: composite computation (`20 §9`), evaluator consistency view (mean/std per evaluator), rankings per group, athlete result cards (optionally shareable with families as feedback—org setting, default off), CSV export.
5. Placement board (`05 §6`) for the target program: seeds from rankings, auto-balance (`20 §8`) with constraints (coach's child fixed, mutual friend requests, siblings together optional, position coverage, max per team, returning players stay option), fairness metrics, manual drag/drop with keyboard alternative, locks, save drafts, publish.
6. Offers: from placements (club mode) send offers with offering (fee/deposit), expiry, message; family accepts (creates registration + deposit payment/installments via checkout) or declines (reason); reminders; auto-expire; next-in-line suggestions; offer dashboard (sent/accepted/declined/expired per team).
7. Rec-league team formation without tryouts: balance by age, prior-season coach rating (optional 1–5 entered by coaches at season end), returning team preference, school, practice-location preference, volunteer-coach child placement; same board UI.

### Acceptance criteria
- Scoring works offline in Playwright (network disabled) and syncs without duplicates when back online; two evaluators scoring the same athlete concurrently both persist.
- Normalization: unit tests show a harsh evaluator's scores are rescaled per `20 §9`.
- Balancer: on seeded 120-player U10 division into 10 teams, team rating averages within 3% of each other, all hard constraints satisfied, deterministic with the same seed, completes < 5 s.
- Offer acceptance e2e: family accepts offer, pays deposit, remainder on autopay plan; roster shows the athlete; decline frees the spot.

---

## Phase 7 — Compliance, safety, player cards

### Tasks
1. Credential types library (defaults from Phase 1), requirements per role/scope, person credentials CRUD (upload document, number, dates), review queue for compliance officers (approve/reject with reason), self-service upload by the person (from portal "To do"), expiry computation (months or fixed month-day), reminders job (`credentials.expiry`).
2. Compliance gating (`04 §5`) wired into team staff activation, official assignment, volunteer signup, evaluator assignment; re-evaluation on credential change/expiry; override flow.
3. Background checks: manual provider (full flow with FCRA disclosure/authorization captured from the candidate in portal, result recording, adjudication, pre-adverse/adverse notice templates and 5-business-day wait enforcement), Checkr adapter (create candidate, invitation, webhook `report.completed`, map results) behind org + platform config, fees (org pays by default; option to charge the volunteer via invoice).
4. Compliance dashboard (`05 §6`), bulk reminders, exports (step-up).
5. Injuries & concussion: coach/staff injury report (mobile), guardian notification, suspected concussion auto-sets roster status `injured` across all team seasons, return-to-play clearance upload by guardian or staff, compliance review, status restoration, history on person profile.
6. Incidents: report form (any staff; families via "Report a concern" link), restricted SafeSport category visible only to compliance/owner, review workflow, resolution, audit.
7. Discipline records (manual here; automatic creation from results/cards in Phase 9): suspensions with games served tracking, blocks in lineups, visibility to team staff.
8. Player/staff cards: generate per season/program with photo, name, team, age group, card number, QR (signed verification URL), validity; print sheet (PDF, 8 per page) and digital card in portal; revoke; verification page shows minimal info.
9. SafeSport communication rules (`04 §4`) as a shared policy used by Phase 10 messaging/chat (implement the policy + tests now).

### Acceptance criteria
- A coach missing SafeSport cannot be activated on a team; uploading and approving the certificate activates them automatically and notifies them; credential expiry demotes to `pending_compliance` and removes Restricted access within the next job run (test with injected clock).
- FCRA flow test: "consider" result cannot be adjudicated ineligible until pre-adverse notice + 5 business days elapsed.
- Concussion flow e2e: coach reports suspected concussion on phone → athlete shows injured on roster and cannot be added to a lineup → guardian uploads clearance → compliance approves → athlete active.
- Player card QR verification page reveals no DOB, contact or medical data.
- Checkr adapter tested with recorded fixtures; disabled cleanly when unconfigured (UI hides the option).

---

## Phase 8 — Facilities scheduling, schedule generator, calendar, closures

### Tasks
1. Events CRUD (all kinds) with recurrence (RRULE series with "this/following/all" edits), participants, spaces or free-text locations, published flag, arrival time, notes; conflict detection (team, space incl. split hierarchy, coach double-booking across teams, official double-booking) with override reasons for soft conflicts only (space double booking is never overridable).
2. Allocations: assign recurring practice blocks to teams/divisions; "practice slot picker" for coaches (optional org setting: coaches pick from allocated pool first-come) with approval.
3. Schedule generator (`20 §6`) as a pg-boss job with progress events via SSE; UI in `05 §6`; apply atomically (all events + bookings) with rollback on conflict; discard; rerun with different seed; explanation report of unscheduled games with reasons.
4. Manual schedule tools: drag/drop in resource calendar, bulk shift (move all games on date X to date Y), swap home/away, CSV import (port legacy importer with mapping), CSV/PDF export per team/division.
5. Publishing: draft vs published; publishing notifies affected families (Phase 10 fan-out; before Phase 10, queue in notifications table); change notifications batched (one message per family per 15-minute window listing all changes).
6. Closures/rainouts: create closure for facility/space/org and time window → preview affected events → mark canceled/postponed → notify all affected guardians, coaches, officials, volunteers via all channels (emergency category) → closure banner on portal and public site → reschedule queue.
7. Reschedule requests: coach requests with reason and proposed slots from free availability; scheduler approves (moves event) or declines; opponent coach notified.
8. ICS feeds: per account (family), per team, per facility; tokenized; updates propagate.
9. Facility public pages with map, directions, field layout image, parking notes.

### Acceptance criteria
- Generator on seeded rec soccer league (6 divisions, 48 teams, 8 fields with split halves, 10 Saturdays): all games placed or explained, zero hard-constraint violations, home/away difference ≤ 1 per team, no team plays twice in a day, coaches with two teams never double-booked, completes within 60 s time budget; deterministic by seed.
- Closure e2e: scheduler closes North Park Fields for Saturday → 24 games marked postponed → every affected guardian account receives an in-app + email notification (Mailpit) → public schedule shows banner.
- Recurring practice series edit "this and following" behaves correctly across DST change (test with America/Chicago and America/Phoenix).
- ICS feed validates with an iCalendar parser and reflects a moved game.

---

## Phase 9 — Game day, results, stats, standings, brackets, tournaments, officials, attendance

### Tasks
1. Attendance & RSVP: families RSVP per event (per child), coaches see counts and names; attendance taking (present/absent/late/excused) online and offline; check-in/out for academy with authorized pickup verification (`household_members.can_pick_up`); attendance reports.
2. Coach game-day screen (phone, offline-capable per `01 §11`): roster with allergy/injury/suspension flags and emergency contacts one tap away (call/text links), lineup builder (positions from profile, batting/serve order where relevant), minimum playing time tracker by period with warnings, live score entry (format-specific), final submission.
3. Results workflow: entry by authorized roles (scheduler, coach if enabled, official, site director), optional opponent confirmation, dispute flag, finalization, result audit trail, forfeits, abandoned games; results publish to standings/brackets immediately; live score SSE to public pages (if public).
4. Stats entry per contest (enabled keys), leaderboards per program/division with privacy defaults.
5. Standings engine wiring: configs per program/division (defaults from sport profile), snapshot recompute on finalization, public/members/hidden visibility, printable standings.
6. Individual-sport results: meet/competition setup (events per `contestFormats`, age/gender splits, entries per athlete with seed times/marks), heat/lane/flight assignment (seeded fastest-last for timed events), results entry grid, rankings with ties, place points and team scores, results export (CSV/PDF), personal bests per athlete (hybrid sports).
7. Brackets & tournaments (`20 §7`): pools with round robin generation, pool standings, pools → bracket seeding, single/double elimination with byes and third-place/consolation, auto-advance on result, bracket view (responsive, printable), tournament program with external team entries (Phase 5), tournament schedule across many fields (generator mode "tournament": pool games then bracket slots), check-in of teams, tournament director dashboard (games in progress, delays, results missing).
8. Officials: official profiles and availability, positions per sport profile, assignment board (games × positions, filters, conflict/travel/max-games checks, compliance gating), offer/accept/decline flow with notifications, self-assign from open games (org setting), game reports, no-show tracking, pay rates by division/position, pay batches, yearly totals, CSV export.
9. Discipline automation: cards/ejections entered in results create discipline records; suspension rules from sport profile (e.g. red card = 1 game); games-served counting on subsequent finalized games; lineup blocking; appeals status.
10. Season end: end-of-season survey (to families, simple NPS + free text, en/es), coach player-rating capture (feeds next season's balancing), awards/participation certificates (PDF), season archive.

### Acceptance criteria
- Result entry validates per format for all seeded sports; standings recompute correctly after finalization, correction and forfeit (golden-file tests per sport).
- Double-elimination 13-team bracket with byes generates the correct structure and advances winners/losers correctly through the if-necessary final.
- Swim meet e2e: 40 athletes entered into 6 events, heats seeded, times entered, ties share place, team scores computed with configured place points.
- Officials e2e: scheduler assigns referee + 2 ARs to 10 games, one official declines, reassigned; pay batch totals match assignments.
- Offline coach e2e: network off → attendance + score entered → network on → synced, conflict surfaced if the scheduler changed the score meanwhile.
- Discipline: red card creates 1-game suspension; player blocked in next lineup; served after next finalized game.
