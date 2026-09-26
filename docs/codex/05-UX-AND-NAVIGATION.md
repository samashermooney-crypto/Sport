# 05 — UX and Navigation

> **Visual design is fixed.** This document changes information architecture, flows and screen content only. Every screen uses the existing design system unchanged (`01-ARCHITECTURE.md §11a`, decision D19).

## 1. UX principles (apply to every screen)

1. **Task-first, not table-first.** Every area opens on "what needs doing" plus the primary action, then the list.
2. **Three-minute rule.** A returning family re-registers a child in ≤ 2 minutes and ≤ 4 screens; a new family completes registration + payment in ≤ 5 minutes. A volunteer admin copies last season and opens registration in ≤ 15 minutes. Playwright journeys assert screen counts.
3. **Phone parity.** Every console task works at 390 px width. Tables switch to card lists under 640 px. Primary actions sit in a sticky bottom bar on phones. No horizontal page scroll (tables may scroll within their container only on desktop).
4. **Honest states.** Loading skeletons, empty states with a next action, error states with retry, and explicit "uncertain result" handling for writes (from `legacy/web/api.ts`). Never show success before the server confirms. Money screens show pending/processing states from Stripe truthfully.
5. **Undo over confirm** for reversible actions (archive, move player between teams on a draft board). **Confirm with consequences** for irreversible ones (refund, send message to 600 families, publish schedule): the dialog states exactly what will happen ("Email 412 guardians and text 390 phones now").
6. **Bulk everything.** Lists support multi-select with bulk actions (message, assign team, apply discount, mark attendance, export).
7. **Sport-aware language** from the sport profile (`03 §7`).
8. **No dead ends.** Every validation error names the fix; every blocked action says why and links to the fix (e.g. "Coach can't be activated: SafeSport training missing → Send reminder").
9. **Global search** (`/` shortcut and header field): people, households, teams, programs, invoices (#), events. Results respect permissions.
10. **Keyboard-first console** for power users: command palette (`Cmd/Ctrl+K`) with navigation and common actions.

## 2. Surfaces and URL structure

| Surface | Base path | Audience |
|---|---|---|
| Marketing site | `/` (existing landing, updated) | Prospects |
| Auth | `/sign-in`, `/sign-up`, `/magic`, `/mfa`, `/reset`, `/invite/:token`, `/verify/:token` | Everyone |
| Org onboarding | `/start` | New org owners |
| Admin console | `/o/:orgSlug/*` | Org roles |
| Member portal | `/me/*` | Guardians, adult athletes, athletes 13–17, coaches, officials, volunteers, evaluators |
| Public org site | `https://{slug}.APP_DOMAIN/*` and `/o/:orgSlug/site/*` fallback; custom domains | Public |
| Embeds | `/embed/:orgSlug/:widget` | External websites |
| Platform console | `/platform/*` | Platform staff |

## 3. Admin console information architecture

Left sidebar (collapsible; on phones a bottom tab bar with Home, Programs, Schedule, Money, More):

- **Home** — Action Center (§5), today's events, registration pace, money snapshot.
- **People** — Members (people search/list), Households, Staff & Volunteers directory, Imports, Merge duplicates.
- **Programs** — Seasons, Programs (list by season; wizard to create), Registrations, Waitlists, Approvals, Offers, Evaluations (tryouts), Classes (academy mode).
- **Teams** — Teams (persistent), Team seasons & rosters, Team formation board, Team staff, Player cards.
- **Schedule** — Calendar (month/week/day/resource-by-space view), Games & Results, Schedule generator, Facilities & Spaces, Allocations, Closures, Reschedule requests, Officials (assignments, availability, pay), Brackets & Tournaments, Standings.
- **Money** — Overview, Invoices, Payments, Payment plans & Autopay, Refunds, Disputes, Credits, Discounts (codes + automatic rules), Financial aid, Payouts & Reconciliation, Team finances, Fundraising, Sponsors, Store & Uniforms.
- **Communication** — Messages (compose, scheduled, sent with delivery stats), Automations (notification settings per type), Templates, Conversations (moderation), Suppressions.
- **Safety** — Compliance dashboard, Credentials, Background checks, Injuries & return-to-play, Incidents, Discipline.
- **Volunteers** — Requirements, Roles, Shifts, Signups & hours, Buyouts.
- **Reports** — Report builder, Saved & scheduled reports, Standard reports (registration by program/division/age/gender/ZIP; retention YoY; revenue by program; aging receivables; installment forecast; payouts reconciliation; compliance status; attendance; volunteer completion; evaluation results; aid awarded; uniform sizes; official pay).
- **Website** — Pages, News, Menu, Theme, Domains, Embeds, Contact submissions.
- **Settings** — Organization profile & branding, Users & roles, Sports (profiles), Forms & waivers library, Registration defaults, Payments (Stripe connect, service fee, refund policy, tax rates, GL codes, installment templates), Communication (sender name, reply-to, SMS consent text), Compliance requirements, Federation (parent/child orgs), Plan & billing, Data (exports, privacy requests, retention policy), Audit log.

Header: org switcher, global search, command palette, notifications bell, help, account menu (profile, security/MFA, sessions, switch to portal).

## 4. Member portal information architecture (`/me`)

Bottom tabs on phone / top nav on desktop:

- **Home** — "To do" (sign waiver, finish registration, pay balance, RSVP, volunteer shift needed, credential expiring, offer awaiting response), next 3 events per family member, announcements.
- **Schedule** — family calendar across all orgs and kids, filter by person/team, RSVP, directions, ICS subscribe, closure banners.
- **Teams** — each team: roster (per visibility), schedule, standings, conversation, staff contacts.
- **Register** — discover programs across orgs the family belongs to + search public programs by org link; cart; saved profiles.
- **Payments** — balances per org, invoices, pay now, installments & autopay, payment methods, receipts, donation receipts, tax-year statement.
- **Family** — people profiles, medical & emergency info, documents (waivers signed, player cards), guardians, household settings.
- **Volunteer** — requirement progress, shifts, sign up.
- **Messages** — inbox (campaigns + notifications) and conversations.
- **Coach / Official / Evaluator** sections appear when the account has those relationships: Coach → My teams (roster with emergency panel, attendance, lineups, score entry, injury report, team message); Official → Assignments (accept/decline, game report, pay); Evaluator → Sessions (scoring UI).
- **Account** — profile, security, notifications preferences, language, sessions, connected orgs.

## 5. Action Center (console Home) — required cards

Each card shows a count, the top items, and one-click bulk actions. Cards appear only when non-empty and permitted:

- Registrations awaiting approval; waitlist offers expiring in 24 h; offers unanswered.
- Unpaid balances past due (count, amount) → "Send reminder" bulk.
- Failed autopay installments in last 7 days → retry / contact.
- Disputes needing evidence (with due date).
- Staff pending compliance (by missing credential) → "Send reminder".
- Credentials expiring in 30 days.
- Teams without head coach / below roster minimum / over roster limit.
- Unassigned players (registered, no team) by division.
- Games without officials in the next 14 days.
- Games in the past without results.
- Schedule conflicts or events at closed spaces.
- Reschedule requests open.
- Open incidents / injuries awaiting return-to-play.
- Volunteer shifts unfilled in next 14 days; households behind on requirements.
- Unread contact-form submissions.
- Imports with errors; messages failed to deliver (bounces).
- Stripe account requirements due (from `requirements.currently_due`).

## 6. Key screen specifications (non-exhaustive; every listed area needs full CRUD screens)

- **Program wizard** (5 steps): Basics (season, sport profile, mode, name, dates) → Divisions (generate from age method: e.g. "U8–U14, boys & girls" creates 14 divisions) → Offerings & pricing (price, early/late, installments, sibling rules, add-ons) → Forms & waivers (pick from library, required emergency contact/medical sections toggles) → Review & publish. "Copy from last season" pre-fills everything and shifts dates by a chosen offset.
- **Registration checkout (family)**: choose participant(s) (or add child) → choose program/offering (eligibility shown inline with reasons) → per-participant questions (only unanswered or expired ones; profile answers pre-filled) → waivers (scroll + type name or draw) → add-ons (sizes) → volunteer commitment or buyout → cart review with discounts, aid, service fee line, payment plan choice → pay (Payment Element) → confirmation with next steps and calendar link. Session saved and resumable; capacity held 20 minutes with visible countdown only in the final two steps.
- **Team formation board**: columns = teams in a division, cards = athletes with rating, age/grade, position, flags (friend request, sibling, coach's child, new/returning, school). Drag and drop (with keyboard alternative: select athlete → "Move to…"), auto-balance button with constraint panel, fairness metrics per team (avg rating, variance, position coverage, returning count), lock athletes, publish placements → notifications.
- **Schedule generator**: pick program/divisions → constraints form (season dates, game days/times per division, spaces allowed, games per team, max games per day/week, rest days, blackout dates, team requests, home/away balance, rivalries/same-club avoidance) → run (progress) → review draft on calendar and list with violation report and score → edit drafts → apply atomically → publish with notification.
- **Calendar**: month/week/day/agenda plus **resource view** (spaces as rows, time as columns) for field managers; drag to move events (validates conflicts live); closure overlay; filters by program/division/team/space.
- **Result entry**: format-specific form from the sport profile; mobile-first large inputs; offline capable for coaches; "confirm result" for the opposing coach when `ProgramSettings.resultConfirmation` is on.
- **Invoice detail**: lines, discounts, fees, installments timeline, payments with allocations, refunds, credit applications, disputes, audit history, actions (record offline payment, refund, apply credit, adjust, void, change plan, resend).
- **Person profile**: header with photo, age/grade, flags (allergy, injured, suspended, non-compliant, balance due), tabs: Overview, Registrations & teams, Family, Medical (permission-gated), Forms & waivers, Credentials, Payments, Attendance, Evaluations, Communication history, Audit.
- **Compliance dashboard**: matrix of staff × required credentials with status colors, filters by program/team/role, bulk remind, order background checks.

## 7. Email/SMS/push content rules

- Every system notification has a template per locale (en, es) in React Email (email) and short text variants (SMS ≤ 160 GSM-7 chars where possible, push ≤ 110 chars).
- Emails include the org name and logo, a plain-text part, the org's physical address and an unsubscribe link for non-operational categories (CAN-SPAM), and a "Why am I getting this?" line.
- Never include Restricted-tier data in any message body. Links go to authenticated pages.
