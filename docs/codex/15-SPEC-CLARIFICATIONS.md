# 15 — Spec Clarifications (binding)

These resolve gaps and conflicts found by reviewing the spec against the code on `rebuild/phase-1` (commit `629f4cb`). Where this file conflicts with `02`/`10`/`11`, **this file wins**. Codex may add DECISIONS.md entries that build on these; it may not contradict them without a DECISIONS.md entry explaining a concrete defect.

## C1 — Recurrence: structured JSON, not RRULE text (affects 02 §H, §J, §P; Phases 3, 8, 9, 12)

Replace every `rrule text` column with `recurrence jsonb` validated by `shared/src/recurrence.ts` (Track B):

```ts
type Recurrence =
  | { kind: "once"; date: LocalDate }
  | { kind: "weekly"; interval: 1 | 2 | 3 | 4; byDay: Weekday[]; startsOn: LocalDate; endsOn: LocalDate | null; count?: number; exceptions: LocalDate[]; additions: LocalDate[] }
  | { kind: "monthly_nth_weekday"; nth: 1 | 2 | 3 | 4 | -1; weekday: Weekday; startsOn: LocalDate; endsOn: LocalDate | null; exceptions: LocalDate[] };
type TimedRecurrence = { recurrence: Recurrence; startTime: LocalTime; durationMinutes: number; timezone: IANAZone };
```
- `expand(timed, rangeStart, rangeEnd) → { startsAt: Instant, endsAt: Instant, localDate }[]` using Temporal. Wall-clock time is preserved across DST. For series occurrences (unlike single entries, DEC-005): a local time inside a DST gap moves forward by the gap length; an ambiguous local time uses the earlier instant. Property tests across America/Chicago, America/Phoenix, America/New_York, Pacific/Honolulu.
- `toRfc5545(timed)` for ICS export only.
- Recurring events are stored as an `event_series(id, org_id, recurrence jsonb, start_time, duration_minutes, timezone, template jsonb)` row plus materialized `events` rows (with `series_id`) for the next 18 months; a daily job extends the horizon. "This / this and following / all" edits split or update the series and its future materialized events in one transaction.

## C2 — Encryption applies to the Restricted tier only (fixes conflict between 02 §C and 04 §2)

Form responses store Public/Internal/Sensitive answers in `answers jsonb` and Restricted answers in `answers_enc`. Sensitive data is protected by access control and audit, not field encryption. Only columns listed as `_enc` in `02` plus Restricted form answers are encrypted.

## C3 — Guardianship: one source of truth for access (Phase 2)

- **Access** is computed only from `person_account_links` (`self` / `guardian`, active = `revoked_at IS NULL`). `household_members` roles are descriptive (contact, billing, pickup) and never grant data access by themselves.
- Every adult who has an account and is linked to anything in an org has their own `people` row in that org with an active `self` link.
- Linking a guardian (staff action or accepted guardian invitation) is one transaction: create the guardian's `people` row + `self` link if missing → create the `guardian` link to the child → add the guardian to the child's household as `guardian` (the child's primary household unless staff picks another) if not already a member.
- Revoking guardian access revokes the link only; household membership stays until staff removes it.
- Policy helper `isGuardianOf(ctx, personId)`; helper `accessiblePeople(ctx)` returns self + guardian-linked people. All portal endpoints use these.

## C4 — Cross-org portal lookups (extends DEC-009)

Extend the `accounts.linked_org_ids` maintenance trigger to also fire on insert of an active `person_account_links` row. Portal endpoints spanning orgs (`/me/family`, `/me/schedule`, `/me/payments`, `/me/inbox`) iterate `linked_org_ids`, query each org inside `withOrg`, and merge results in memory (sorted, paginated after merge). The index is a locator only; revocations do not remove entries; policies remain authoritative.

## C5 — Search text

`people.search_text` is maintained by a trigger (not a generated column): lowercase, `unaccent`-ed concatenation of first, preferred, middle, last names, email, and phone digits. Enable the `unaccent` extension and wrap it in an `IMMUTABLE` SQL function used by both the trigger and queries. GIN trigram index on `search_text`. Same approach for households (name + member names) and teams.

## C6 — Duplicate detection

Candidate duplicate when any: (same `date_of_birth` AND `similarity(full_name_a, full_name_b) ≥ 0.55`), same non-empty email, same non-empty phone. Show candidates with the matching reasons; never auto-merge. Imports mark candidate rows `merge?` and require a per-row choice (or a bulk "skip all duplicates").

## C7 — Import limits and formats

≤ 20,000 rows and ≤ 20 MB per batch. CSV (UTF-8, UTF-8 BOM, Windows-1252 auto-detected) and XLSX (first sheet, `exceljs`). Dates accepted: `YYYY-MM-DD`, `MM/DD/YYYY`, `M/D/YYYY`, `MM-DD-YYYY`, Excel serial numbers; ambiguous `DD/MM` is not accepted (reject with an actionable issue). Validation runs in the worker with progress over SSE. Commit is one transaction.

## C8 — Age and grade display before the sport engine lands

Phase 2 screens show age from `shared/src/dates.ts`. Grade and age-group labels appear once Track B's `shared/src/sport/age.ts` is on trunk; wire them in then (Track A task). Until then, graduation year is displayed as "Class of 2033".

## C9 — Sport profile versions

Add `sport_profile_versions(org_id, sport_profile_id, version, profile jsonb, created_by, created_at)`, append-only, PK `(sport_profile_id, version)`. `sport_profiles` holds the current version. Editing a profile inserts a new version. Contests reference `(sport_profile_id, profile_version)` and render results with that version.

## C10 — Space bookings use leaf rows (replaces the trigger-expanded description in 02 §H)

`space_bookings(id, org_id, booking_group_id, leaf_space_id, during tstzrange, event_id, allocation_id)`. Booking any space inserts one row per **leaf** descendant (a space with no children is its own leaf) sharing a `booking_group_id`. Constraint: `EXCLUDE USING gist (leaf_space_id WITH =, during WITH &&)`. `during` includes the sport-profile buffer after the event. Adding child spaces to a space with future bookings is rejected with an explanation (move or cancel those bookings first). Closures and blackouts are checked by the scheduling service, not by this constraint.

## C11 — Season rollover selection

The rollover preview lists every active team season with a "returning" checkbox (default checked) and each staff assignment with a "carry over" checkbox (default checked). Only checked items are copied; carried staff start `pending_compliance`.

## C12 — Default division

Every program has exactly one `is_default` division (add `divisions.is_default bool`, partial unique per program). It is created with the program, named "All participants", and hidden in the UI while it is the only division. Creating real divisions keeps the default only if it still has registrations or teams.

## C13 — Installment templates belong to finance

Installment plan template CRUD moves from Phase 3 to Phase 4 (Track E). Phase 3's offering editor shows the plan picker only when templates exist (reads via the finance module's service).

## C14 — Actor context

`withOrg` carries `accountId` only. Each request loads `ActorContext` once per org transaction: memberships, active role assignments with scopes, `self`/`guardian` links, active team_staff records, official/volunteer/evaluator relationships. Cache it on the request per org. Policies take `ActorContext`, never raw ids. Role or link changes revoke sessions only where `01 §4` requires; otherwise the next request reloads context.

## C15 — Spine migration requirements (Track A, `50 §4`)

For every spine table: `updated_at` trigger; `version` where the table is a mutable aggregate; forced RLS with the `NULLIF(current_setting('app.org_id', true), '')::uuid` expression (DEC-003); `UNIQUE(org_id, id)` on parents and composite `(org_id, parent_id)` foreign keys on children for: people↔households↔household_members, programs↔divisions↔offerings↔registrations, teams↔team_seasons↔roster_entries/team_staff, invoices↔invoice_lines↔installments↔payment_allocations, events↔contests↔contest_participants↔contest_results; `CHECK` constraints for every enum in `02`; `capacity_counters` checks `confirmed >= 0 AND held >= 0`; partial unique indexes listed in `02` (active registration per program/person, active roster entry, active jersey number, one pending invitation, etc.); indexes on every FK and every list filter named in phase specs. Test: the RLS coverage test passes; a schema test asserts every `org_id` FK pair is composite where listed.

## C16 — Event timezone

`events.timezone` is set at creation from the space's facility timezone, else the org timezone, and never changes when the org timezone changes. All display/formatting uses the event's timezone with the viewer's local time shown secondarily when different.

## C17 — Program URLs

`programs.slug` is unique per org and immutable after the program is published (changing it requires unpublish). Public URL: `/programs/:slug` on the org site; portal URL `/me/register/:orgSlug/:programSlug`.
