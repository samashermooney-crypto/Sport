# 20 — Algorithms and Business Rules

All functions here are pure where possible (in `shared/src` or `server/src/modules/*/logic.ts`), deterministic given inputs + injected clock/seed, and unit/property tested.

## §1 Money

- Integer cents only. Never floats for money. Percentages in basis points (bps, 1% = 100).
- `percentOf(amount, bps)` = `roundHalfUp(amount * bps / 10000)` using integer math (`(amount * bps + 5000) / 10000` floored, for non-negative amounts; negative amounts mirror).
- Allocation of a total across parts (`allocate(total, weights)`): largest-remainder method so parts sum exactly to total; ties broken by earlier index. Used for proportional refunds, discount spreading and installment splits.
- Display with `Intl.NumberFormat(locale, { style: "currency", currency })`.

## §2 Pricing pipeline, discounts and capacity holds

**Order of operations per checkout (deterministic, snapshot stored on the checkout):**

1. Base price per participant line = offering price, replaced by early-bird/late price if `now` (org timezone) is within those windows.
2. Add-on lines (product variants) at their prices.
3. Automatic discount rules, in `priority` order; within sibling rules, sort the household's participant lines in the same season by base price **descending**, the first gets no sibling discount, the 2nd gets rule tier 2, 3rd+ tier 3 (applies across checkouts in the same season: existing confirmed registrations count toward the sibling position but are never retroactively discounted). Non-stackable rules: only the largest discount per line applies.
4. Discount code (one per checkout unless `stackable`) applied to eligible lines; percent codes apply per line; fixed codes spread across eligible lines by `allocate` weighted by line amount; a line never goes below 0.
5. Financial aid award for the household/season as `aid` lines (percent of remaining eligible amount or fixed spread by `allocate`).
6. Account credit (if family chooses to apply) reduces amount due, recorded as credit application, not as a line.
7. Service fee (if pass-through enabled) computed on the amount being charged now (see §3).
8. Tax on taxable product lines only.

Every discount/aid line references its `parent_line_id` so refunds can reverse them proportionally.

**Capacity holds:**
- On entering the payment step (or at "Reserve my spot" for free programs), for each participant line: in one transaction, `UPDATE capacity_counters SET held = held + 1 WHERE subject = X AND (capacity IS NULL OR confirmed + held < capacity) RETURNING *`. Zero rows → `CAPACITY_FULL` (offer waitlist). Checks offering, division and program counters in a fixed order (program → division → offering) to avoid deadlocks.
- Hold expires 20 minutes after creation (extended by activity up to 45 minutes total). `checkout.expire` releases (`held − 1`).
- On payment success (or free confirmation): `held − 1, confirmed + 1` in the same transaction that confirms registrations. If the hold already expired and capacity is now full, the payment is still honored only if the checkout was in `awaiting_payment` before expiry (the hold is kept while a PaymentIntent is processing); otherwise refund automatically and notify (should be practically impossible; test it).
- Cancellation/withdrawal/transfer out: `confirmed − 1` then waitlist advance.

## §3 Fees and installments

**Application fee (platform revenue)** per PaymentIntent = `percentOf(amount_charged, org.application_fee_bps) + org.application_fee_fixed_cents`, capped at `amount_charged − 1`. Service fee lines are included in `amount_charged`.

**Service fee pass-through (D8).** Org config: `{ enabled, mode: "cover_costs" | "custom", custom_bps, custom_fixed_cents }`.
- `cover_costs`: fee is set so the org nets the base amount after application fee **and** an estimated processor fee `P = (processing_bps, processing_fixed)` (platform config; default 290 bps + 30¢, same for all methods so the fee is method-independent). Gross-up: `total = ceil((base + fixed_total) / (1 − bps_total/10000))` where `bps_total = app_bps + processing_bps`, `fixed_total = app_fixed + processing_fixed`; `fee = total − base`. Because processing costs differ by method, the org may net slightly more on ACH; document this in the org settings help text.
- `custom`: `fee = percentOf(base, custom_bps) + custom_fixed_cents`.
- For installment plans the fee is computed per charge on that charge's amount and shown in the plan schedule up front.

**Installment schedule generation** (`installment_plan_templates`):
- Inputs: invoice total due (after discounts/aid/credits), template (deposit fixed or percent, then N installments on fixed dates or monthly on day D starting next month), today.
- Deposit charged at checkout. Remaining split into N parts with `allocate` equal weights; any remainder cents go to the **first** installment.
- Fixed-date templates skip dates already past at checkout; their amounts roll into the next installment. If no future dates remain, the plan option is not offered.
- Minimum installment amount (template `min_amount_cents`) reduces N if violated.
- Changing an invoice total after the plan exists (staff adjustment, refund, added line) re-spreads the delta across remaining unpaid installments via `allocate`; paid installments never change.

## §4 Invoice and payment states, invariants

Invoice status is **derived**, recomputed in the same transaction as any change:
- `void` if voided; else `paid` if `balance = 0` and `total > 0` (or total = 0 and confirmed); `partially_paid` if `paid + credit_applied > 0` and `balance > 0` and no installment overdue; `past_due` if any installment or the invoice due date is before today (org tz) with unpaid amount; `open` otherwise.
- `balance = total − paid_net − credit_applied`, where `paid_net = Σ succeeded allocations − Σ refunded-to-method allocations for this invoice`, and refunds-to-credit reduce `paid_net` and increase account credit simultaneously.

Invariants (enforced by DB constraints where possible + property tests):
1. `Σ invoice_lines.amount = subtotal − discount + service_fee + tax = total`.
2. `Σ allocations of a succeeded payment = payment.amount`.
3. `Σ refunds of a payment ≤ payment.amount`; refund allocations reference lines of invoices allocated by that payment.
4. `0 ≤ balance ≤ total` except transiently during dispute (disputed amount tracked separately; see §10).
5. Installments of an invoice sum to the planned portion; `paid_cents ≤ amount_cents`.
6. Voiding requires `paid_net = 0`.

Registration effects:
- Checkout success → registrations `confirmed` (or `pending_approval`).
- ACH `processing` → `confirmed` if `confirmOnAchProcessing` (default true), invoice remains unpaid until success.
- Payment failure of the deposit/full payment → registrations revert to `pending_payment` with a 72-hour window to pay (capacity stays held via a converted hold of that duration), then `canceled` with reason `payment_failed` and capacity released.
- Full refund of a registration line does **not** auto-cancel the registration; cancellation is an explicit action that can trigger a refund (policy engine), not vice versa.

## §5 Dunning (autopay) and ACH failures

- `installments.charge` picks installments with `autopay = true`, `status = scheduled|failed`, `next_attempt_at ≤ now`, locks each (`FOR UPDATE SKIP LOCKED`), creates an off-session PaymentIntent with idempotency key `inst:{id}:{attempt}`.
- First attempt at 10:00 org-local on the due date. Retries after failure at +1 day, +3 days, +7 days (4 attempts total). Card errors that are not retryable (`card_declined` with `do_not_honor` is retryable; `expired_card`, `incorrect_number`, `stolen_card`, `lost_card`, authentication required) stop automatic retries and ask the family to update the method.
- Each failure: notify family (email + push + in-app, SMS if consented) with a pay-now link; Action Center entry; after final failure mark `failed`, invoice `past_due`, optional late fee line (org setting: amount, applied once per installment).
- Card expiring before a scheduled installment: notify 14 days before.
- ACH failure (`payment_intent.payment_failed` after `processing`): allocation reversed, installment/invoice back to unpaid, family and finance notified; returned ACH fee is not passed to families automatically (org may add an adjustment).

## §6 Schedule generator

**Input (`GeneratorInput`)**: divisions with teams; games per team (or "round robin once/twice"); season date range; allowed weekdays and time windows per division; game duration + buffer from sport profile; eligible spaces per division (suitability); space availability (windows minus blackouts minus existing bookings); max games per team per day (default 1) and per week; minimum rest hours between a team's games; team blackout dates (requests); coach links (people coaching multiple teams); household links (siblings across teams, optional soft constraint); preferred times by age (younger earlier: soft); home/away balance; home field preference; same-club avoidance in early rounds (federation); seed; time budget seconds (default 45, max 120).

**Step 1 — Pairings.** Per division, generate the round-robin schedule with the circle method (add a bye for odd team counts). For "N games per team" not equal to a full round robin, take rounds sequentially (double round robin if needed) and truncate to N, balancing opponents. Assign home/away alternating per team; for double round robin mirror the second half.

**Step 2 — Slots.** Expand availability into discrete slots per space: start times on a 15-minute grid where `[start, start + duration + buffer)` fits inside a window; mark slots overlapping existing bookings or parent/child space bookings as unavailable.

**Step 3 — Assignment (constructive + local search).**
- Order games by "most constrained first" (fewest feasible slots; ties by division age ascending).
- For each game, choose the feasible slot with the lowest incremental penalty. Hard constraints (must hold): space free (including split hierarchy), team not already playing overlapping or on the same day beyond max, rest hours, team blackout dates, coach not in two overlapping games (+ 30 minutes travel buffer if different facilities), space suitability, within season dates. If no feasible slot, leave unscheduled.
- Soft penalties (weights configurable, defaults): home/away imbalance per team (10 per unit above 1), weekly game spread variance (5), preferred-time deviation by age (1 per 30 minutes), sibling games overlapping at different facilities (8) / same facility overlapping (3), same opponent twice in a row (4), unused home field preference (2), early-round same-club matchups (3).
- Local search: simulated annealing over moves {move game to another feasible slot, swap two games' slots, swap home/away} until the time budget, accepting worse moves with probability `exp(−Δ/T)`, `T` decaying geometrically from 50 to 0.1. Retry insertion of unscheduled games each 1,000 iterations.
- Output: draft events, unscheduled games with the blocking reasons (e.g. "No suitable space Saturday 8–12 for U12 after blackouts"), total penalty, per-team metrics (home/away, games per week, earliest/latest times).

**Tournament mode**: pool games first within pool days, then bracket slots reserved in order of rounds with minimum rest between a team's consecutive games; bracket slots hold placeholders ("Winner of Game 12").

## §7 Standings, tiebreakers and brackets

**Standings computation** for a scope (division/program):
1. Collect finalized contests with `counts_for_standings` and stage in `include.stages`.
2. Per team: played, wins, losses, ties, OT wins/losses, forfeits, scored, allowed, differential (capped per match by `maxGoalDifferential` if set), sets won/lost, set points for/against, points (per config), win percentage = `(wins + winPercentageTieValue × ties) / played`.
3. Primary rank by `rankBy`.
4. **Tiebreak groups**: for teams equal on the primary value, apply tiebreakers in order. For head-to-head tiebreakers with 3+ teams, build a mini-table using only contests among the tied teams; if the criterion separates the group into subgroups, recursively restart the full tiebreaker list for each still-tied subgroup (not continuing from the current position). If all tiebreakers are exhausted, use `coin_toss_manual` order (admin-set) and flag "manual tiebreak required" in Action Center.
5. Output rows with rank, values and the tiebreaker that decided each boundary (for transparency).

**Bracket generation:**
- Size = next power of two ≥ entrants; byes = size − entrants, awarded to top seeds.
- Standard seeding placement (1 vs size, 2 vs size−1 placed in opposite halves recursively, e.g. for 16: 1-16, 8-9, 5-12, 4-13, 6-11, 3-14, 7-10, 2-15).
- Double elimination: losers of winners-bracket round r drop into losers-bracket slots, alternating placement to avoid immediate rematches; grand final with optional "if necessary" game when the losers-bracket champion wins the first final.
- Pools → bracket: rank within pools by standings, then cross-seed (A1 vs B2, B1 vs A2 …) or overall-seed by points per game (config).
- Result finalization advances winner (and loser in double elim/consolation) into the target slot in the same transaction; editing a result after downstream games were played requires a confirmation and cascades only if downstream results are not final (else blocked with explanation).

## §8 Team balancing

**Input**: players with rating (evaluation composite, coach rating from last season, or default median), age/grade, positions (e.g. goalkeeper), flags; constraints: fixed placements (coach's children, locks), mutual friend requests (both named each other; max one pair per player), siblings together (optional), max roster per team, min position coverage (e.g. ≥1 goalkeeper per team), returning players stay (optional), school/location preference (soft).

**Algorithm**: (1) Place fixed players and hard-linked groups (friends/siblings as units with summed rating). (2) Snake draft remaining units in descending rating into the team with capacity that minimizes current total rating (serpentine order as tie-breaker), respecting position coverage by drafting required positions first. (3) Local improvement: repeatedly try swaps of units between teams that reduce the objective `σ(team mean rating) × 100 + σ(team size) × 50 + position coverage violations × 1000 + returning-player split × 5 + soft preference misses × 2` until no improving swap or time budget (5 s). Deterministic by seed. Output metrics per team.

## §9 Evaluation scoring

- Per score, if `normalization = z_score_per_evaluator`: for evaluator e and criterion c within the event, `z = (score − mean_e,c) / sd_e,c` (if sd = 0 or fewer than 8 scores, fall back to raw minus mean); rescale to the rubric scale: `normalized = globalMean_c + z × globalSd_c`, clamped to scale bounds.
- Athlete criterion value = mean of (normalized) scores across evaluators. Composite = Σ(weight_c × value_c) / Σ(weight_c) over criteria applicable to the athlete (position-specific criteria only for athletes evaluated in that position).
- Rank within group (age group + gender, or custom group); ties broken by number of evaluators (more first) then by name for stable display; flag athletes with fewer than 2 evaluators.

## §10 Refund and dispute liability (destination charges)

- Refunds: create Stripe refund on the platform charge with `reverse_transfer: true` so the connected account funds it; `refund_application_fee` per plan setting (default true = platform returns its fee proportionally). If the connected account balance is insufficient, Stripe debits per its rules; surface failures to finance.
- Disputes: on `charge.dispute.created`, create a transfer reversal for the disputed amount + dispute fee from the connected account (platform would otherwise bear it), mark invoice amounts `disputed` (excluded from balance until resolved), notify finance with evidence due date. On `won`: re-transfer the amount (and fee if returned) to the connected account. On `lost`: keep reversal; invoice shows the disputed amount as unpaid again (org decides to pursue or write off `uncollectible`).
- All these movements are recorded as ledger entries so the reconciliation report explains every payout difference.

## §11 Proration (academy tuition and mid-season changes)

- Monthly tuition, joining mid-month: `prorated = allocate(monthly, sessionsRemainingInMonth / sessionsScheduledInMonth)` (session-count based, not calendar days; holidays excluded). Org setting may disable proration (charge full month) or set "no charge after the 20th, first bill next month".
- Withdrawal with notice period: bill through the end of the notice period; refunds only if a paid period extends beyond it, prorated by remaining sessions.
- Level/tier change mid-month: new tier effective next billing date (default) or immediately with prorated difference (org setting).
- Pauses: no charge for fully paused months; partial months prorated by sessions.

## §12 Waitlist

- Positions are per offering, ordered by join time; staff can reorder (audited).
- `auto` mode: when a confirmed spot frees (capacity counter `confirmed + held < capacity`), the next `waiting` entry gets an offer with expiry `ProgramSettings.offerExpiryHours` (default 48, min 4) and a converted capacity hold lasting until expiry; family accepts by completing checkout (hold consumed); expiry or decline releases the hold and advances. Offers are not sent between 21:00 and 08:00 family-local time; the expiry clock starts at send time.
- `manual` mode: staff choose whom to offer.
- A family cannot hold more than one active offer per participant per program.
- Joining a waitlist collects forms/waivers answers upfront (optional org setting) so acceptance is a one-step payment.
