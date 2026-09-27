# Track B — sport logic and policies

Status: ready-for-integration
Model: GPT-6 Sol
Branch: `track/b-logic`
Current: Queue complete; awaiting Track A integration.
Ready: Age/eligibility — `shared/src/sport/{age,eligibility}.ts`; 11 targeted tests, typecheck and lint green.
Ready: Recurrence — `shared/src/recurrence.ts`; 11 targeted tests across four timezones, typecheck and lint green.
Ready: Sport schema/results/stats/standings — 19 targeted tests, typecheck and lint green; template goldens still pending.
Ready: Pricing/fees — `shared/src/algorithms/{pricing,fees}.ts`; 11 targeted tests, typecheck and lint green.
Ready: Installments/invoice-state/capacity-math — 13 targeted tests, typecheck and lint green.
Ready: Pure policies (compliance, SafeSport, refunds, quiet hours, FCRA) — 15 targeted tests, typecheck and lint green.
Ready: Brackets — single/double elimination, byes, pool seeding and guarded advancement; 5 targeted tests, typecheck and lint green.
Ready: Schedule generator — circle pairings, 15-minute slots, hard/soft constraints, seeded local search and tournament reservations; 7 targeted tests, typecheck and lint green.
Ready: Team balancer — fixed groups, mutual friends, siblings, position coverage, snake draft and seeded swaps; 4 targeted tests, typecheck and lint green.
Ready: Evaluation — evaluator normalization, weighted criteria, group ranks and incomplete flags; 5 targeted tests, typecheck and lint green.
Ready: Proration — joining, withdrawal, tier changes and pauses by scheduled sessions; 6 targeted tests, typecheck and lint green.
Ready: Dunning/waitlist — local 10:00 retries, nonretryable stops, quiet-hour offers and capacity holds; 6 targeted tests, typecheck and lint green.
Ready: Logic edge review — refund rule validation and date parsing; bracket, finance, policy, recurrence, age and stat boundary tests.
Ready: Scoring variants — swim relay points, diving difficulty, cross-country/golf team totals, rugby bonuses and cricket net run rate; 46 golden files checked.
Ready for integration: 30a775f..HEAD — complete Track B queue: age/eligibility, recurrence, sport engine and 46 templates, pricing/fees/installments/invoice-state/capacity/dunning/waitlist, five policies, brackets, schedule generator, team balancer, evaluation, proration, edge review and sport scoring variants.
Requests to other tracks: none
Blocked on: none
Self-review: Checked age and eligibility against `03 §3` and `15 §C8`; date rules reuse `shared/src/dates.ts`.
Self-review: Checked recurrence DST behavior against `15 §C1` across Chicago, New York, Phoenix and Honolulu.
Self-review: Checked money sequencing and state invariants against `20 §1–§5`; all arithmetic uses integer cents.
Self-review: Checked safety policies against `04 §4–§5`, refunds against Phase 5 task 7, and quiet hours against Phase 10.
Self-review: Shared suite, typecheck, lint and build green; no Track B screens or routes require Playwright; registry command is not present yet.
Self-review: 204 shared tests pass; Track B line coverage 95.08%; swim/diving/cross-country/golf/rugby/cricket variants checked against `03 §2, §5–§6`.
