# 04 — Permissions, Privacy and Child Safety

## 1. Permission model

Authorization = **role assignments** (org-level or scoped) + **relationship access** (guardian/self/team staff) + **policy functions**.

- Permissions are string constants in `shared/src/permissions.ts` (e.g. `people.read`, `people.write`, `medical.read`, `registrations.manage`, `finance.refund`, `schedule.publish`). Roles map to permission sets. Policies are written per module in `policy.ts` and tested with a matrix test (every role × every route: allowed/denied as expected).
- Scope: a role assignment with `scope_type = program` grants its permissions only for resources inside that program (its divisions, team seasons, registrations, events, contests). `division` and `team_season` scopes likewise. `season` scope covers all programs in the season. The policy helper `can(actor, permission, resource)` resolves the resource's program/division/team ancestry and checks scoped assignments.
- 404 (not 403) for resources in another org or outside the actor's visible scope.

### Org roles

| Role | Purpose | Key permissions |
|---|---|---|
| `owner` | Legal/financial owner | Everything, including ownership transfer, plan/subscription, Stripe payout account, org closure, deleting data per privacy request |
| `admin` | Runs the org | Everything except owner-only actions |
| `registrar` | Registration & people | programs, offerings, registrations, waitlists, approvals, transfers (no refunds), people & households, forms & waivers, imports; medical read only if org setting `registrarMedicalAccess` |
| `finance` | Money | invoices, payments, refunds (with thresholds), disputes, credits, discounts, aid decisions, payouts, reconciliation, team-ledger oversight, financial reports |
| `scheduler` | Facilities & calendar | facilities, spaces, availability, allocations, closures, schedule generation/publishing, results management, officials assignment, brackets |
| `compliance` | Safety | credentials, background checks, injuries, incidents (incl. restricted), medical read, discipline |
| `communications` | Messaging & site | campaigns to any audience, templates, website, news, sponsors display |
| `director` | Coaching/age-group director (usually scoped) | teams, rosters, evaluations, placements, offers, team staff, schedules (read), attendance, lineups; medical flags for their scope |
| `evaluator` | Tryout scoring | only assigned evaluation sessions: athlete names, bib, age group, photo; no contact info |
| `volunteer_coordinator` | Volunteers | roles, shifts, signups, hours, volunteer requirements |
| `reporter` | Board/read-only | read everything except Restricted tier; no exports of Sensitive tier |

### Team-level and personal roles (derived from records, not role_assignments)

| Relationship | Access |
|---|---|
| `head_coach`, `assistant_coach`, `team_manager` on an **active** team_staff record | team roster; guardian names/phones/emails for team members; emergency contacts; allergy flags and a "medical info on file" indicator; full medical details only if org setting `coachMedicalAccess = full` (default `flags_only`); attendance; lineups; score entry if `ProgramSettings.coachScoreEntry`; team conversations; team calendar; injury report creation |
| `treasurer` (team_staff role) | team ledger, team fee status per family (amounts only), reimbursements |
| Guardian (person_account_link `guardian`) | full read/write of their children's profiles, registrations, forms, medical, invoices of households where `financially_responsible`; team schedule/roster names (per roster visibility setting) |
| Self (adult) | own profile, registrations, invoices |
| Self (athlete 13–17) | own profile read, schedule, team roster names, team conversations (read + post if org enables); cannot register, pay, sign waivers or change medical info |
| Official | own assignments, contest details, game report submission, own pay lines |
| Volunteer | own shifts and signups |
| Evaluator | as above |

A person can hold several of these at once (coach and parent); the UI shows a role switcher, the API computes union access.

## 2. Data sensitivity tiers

| Tier | Examples | Rules |
|---|---|---|
| Public | Published program info, public schedules/standings, team names | Anyone |
| Internal | Names, roster membership, attendance, results | Members with relationship or role |
| Sensitive | Contact info, date of birth, address, photos of minors, grades/schools, financial balances, evaluation scores | Role/relationship required; exports require step-up auth; photos of minors never public unless `media_consent = granted` |
| Restricted | Medical, insurance, custody notes, background-check details, incident narratives (esp. SafeSport), aid applications, government/license numbers | Encrypted at rest; only listed roles; **every read audited**; excluded from general reports unless the report explicitly includes the dataset and the actor has permission; never included in email/SMS/push bodies |

Every form field declares its tier. Report builder columns carry tiers; the builder hides columns the actor cannot see.

## 3. Minors and accounts

- Account sign-up requires date of birth; under 13 → refuse with guidance ("A parent or guardian must create the account").
- Registering a minor requires a guardian account; the guardian attests to guardianship. Staff can add guardians; a second guardian is invited by email (guardian invitation token) and must accept.
- Athlete accounts (13–17) are created only by guardian invitation. Guardians can revoke.
- Waivers for minors are signed by a guardian; athletes 18+ sign their own. When an athlete turns 18 during an active season, the next registration requires their own signature; existing guardian links remain but the adult athlete can revoke guardian access to their own records (not to historical financial records the guardian paid).

## 4. SafeSport-aligned communication rules (enforced in code, tested)

- Any message or chat from an adult (staff/coach/volunteer/official) to a minor athlete account MUST include at least one of that athlete's guardians (auto-added as recipients/members, visibly labeled "Guardian copied").
- `direct` conversations between an adult non-guardian and a minor are impossible to create; the API returns `SAFESPORT_GUARDIAN_REQUIRED` unless a guardian of that minor is a member.
- Team conversations that include minor athletes always include those athletes' guardians.
- Staff cannot see or message athletes' personal phone numbers if the athlete is a minor; SMS to minors goes only to guardians.
- Message history is retained (not user-deletable); staff deletions are soft and visible to compliance officers.
- Report-message and "concern" buttons route to compliance officers as restricted incidents.

## 5. Compliance gating (enforced in code, tested)

- `team_staff` rows become `active` only when every required credential for the role (via `role_credential_requirements`) is `verified` and unexpired on the activation date, and the person is ≥ the role's minimum age. Otherwise status stays `pending_compliance` with the missing list shown to the staff member and admins.
- Credential expiry during a season moves team_staff to `pending_compliance` automatically (job) and notifies the person, team director and compliance officers. Grace period configurable per credential type (default 0).
- Pending-compliance staff lose access to Restricted data and to messaging athletes, keep read access to schedule.
- Official assignments and volunteer shift signups apply the same gate for their roles.
- Admin override exists only for owners, requires a reason, expires within 14 days maximum, and is prominently flagged.

## 6. Audit

Audit (append-only) entries are written for: every create/update/delete-equivalent on any tenant table; every read of a Restricted field or file; every export; every impersonation action; every role change; every login, MFA change and session revocation (global security log); every payment, refund, dispute action and override. Audit `changes` store field-level diffs with Restricted values replaced by `"[redacted]"`. Admins can view audit history for any record they can see; compliance officers see Restricted reads.

## 7. Retention and deletion

Implement in `retention.sweep` with an org-visible policy page:

- Financial records (invoices, payments, refunds, payouts): retained 7 years.
- Waiver signatures and incident/injury reports: retained 7 years after the athlete turns 18 or 7 years after the event, whichever is later.
- Background-check details: retained for the credential validity + 1 year, then details purged, status retained.
- Chat and messages: 3 years.
- Evaluation scores: 2 years after the evaluation event.
- Sessions, magic links, tokens: purged 30 days after expiry.
- Privacy deletion request: anonymize person (names → "Deleted Person", clear contact/medical/photo, keep ids and financial/legal records), revoke account, record completion. Owner or admin performs with step-up auth; subject is notified.
- Org closure: owner requests; data export offered; after 90 days the org is anonymized per the rules above.

## 8. Consent capture

Record versioned consent with timestamp, IP, user agent and exact text for: Terms of Service and Privacy Policy acceptance (account creation), SMS consent (TCPA: explicit, unchecked-by-default checkbox with required disclosure text including frequency, "Msg & data rates may apply", STOP/HELP), autopay authorization (per mandate), ACH mandate (Stripe-provided text), background-check disclosure & authorization (FCRA standalone disclosure), media consent per athlete, marketing email opt-in (separate from operational messages), cookie notice (only strictly necessary cookies are used; state this).
