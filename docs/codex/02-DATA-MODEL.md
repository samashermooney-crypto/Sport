# 02 — Data Model

Conventions for every table unless stated otherwise:
- `id uuid PK` (UUIDv7), `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()` (trigger-maintained).
- Tenant tables have `org_id uuid NOT NULL` with RLS (see `01 §3`). Composite foreign keys `(org_id, x_id)` are used for critical relations so rows cannot point across tenants: give parent tables `UNIQUE(org_id, id)` and reference `(org_id, parent_id)`.
- Mutable aggregates have `version int NOT NULL DEFAULT 1`.
- Soft states use `status` + timestamp columns (`archived_at`, `canceled_at`), never deletes, for records listed as "retained" in `04`.
- Encrypted columns end in `_enc bytea` (see `01 §9`).
- `jsonb` columns are validated by the named Zod schema in `shared/`.

This document lists columns that carry meaning; you add standard columns and indexes (every FK indexed, every list filter indexed).

---

## A. Platform and tenancy

**organizations** (global table, no RLS; access via `orgs` module) — `slug citext UNIQUE` (3–40 chars, `[a-z0-9-]`, reserved words list), `name`, `legal_name`, `kind` (`club|league|association|academy|school|parks_rec|tournament_operator|other`), `timezone` (IANA, validated), `currency` (`USD`), `default_locale` (`en|es`), `country` (`US`), `address jsonb`, `phone`, `email`, `website_url`, `logo_file_id`, `brand jsonb` (`primaryColor`, `accentColor`, validated contrast), `nonprofit bool`, `ein_enc`, `status` (`onboarding|active|suspended|closed`), `plan_id`, `application_fee_bps int`, `application_fee_fixed_cents int`, `settings jsonb` (`OrgSettings` schema: service-fee pass-through config, refund policy text, registration defaults, communication defaults, coach medical visibility, media consent default, volunteer defaults), `version`.

**org_relationships** — `parent_org_id`, `child_org_id`, `type` (`member_club|affiliate`), `status` (`invited|active|suspended|ended`), `data_sharing jsonb` (`FederationSharing`: which datasets the parent may read: `rosters`, `compliance_status`, `team_entries`, `discipline`; never medical), `started_at`, `ended_at`. Unique active pair. Visible to both orgs.

**org_counters** — `org_id`, `name` (`invoice|order|receipt|donation_receipt|bib`), `next_value bigint`. PK `(org_id, name)`.

**org_domains** — `org_id`, `hostname citext UNIQUE`, `verification_token`, `status` (`pending|verified|active|failed`), `verified_at`.

**plans** (global) — `key`, `name`, `monthly_price_cents`, `stripe_price_id`, `application_fee_bps`, `application_fee_fixed_cents`, `limits jsonb`, `active`.

**org_subscriptions** — `org_id UNIQUE`, `plan_id`, `stripe_customer_id`, `stripe_subscription_id`, `status`, `current_period_end`.

**platform_staff** (global) — `account_id UNIQUE`, `role` (`super_admin|support|finance_ops`), `active`.

**impersonation_sessions** (global) — `staff_account_id`, `org_id`, `target_account_id` nullable, `reason text NOT NULL`, `ticket_ref`, `started_at`, `ended_at`, `read_only bool DEFAULT true`. Every action during impersonation is audited with the impersonation id.

**feature_flags** (global) — `key`, `enabled_globally bool`, `org_ids uuid[]`.

**idempotency_keys**, **audit_log** — see `01 §5` and `04 §6`. `audit_log(org_id nullable, actor_account_id, impersonation_id, action, entity_type, entity_id, changes jsonb (redacted diff), ip, user_agent, request_id, created_at)`; append-only (no UPDATE/DELETE grants for app role).

## B. Identity

**accounts** (global) — `email citext UNIQUE`, `email_verified_at`, `password_hash` nullable (magic-link-only accounts), `first_name`, `last_name`, `phone_e164`, `phone_verified_at`, `locale`, `timezone`, `date_of_birth` (required at sign-up; must be ≥ 13 years), `status` (`active|locked|deactivated|anonymized`), `last_sign_in_at`, `version`.

**sessions** (global) — `token_hash bytea UNIQUE`, `account_id`, `kind` (`cookie|bearer`), `client` (`web|ios|android`), `elevated_until timestamptz`, `mfa_verified_at`, `idle_expires_at`, `absolute_expires_at`, `ip`, `user_agent`, `revoked_at`, `impersonation_id`.

**mfa_factors** — `account_id`, `type` (`totp`), `secret_enc`, `confirmed_at`, `last_used_step bigint` (replay protection). **mfa_recovery_codes** — `account_id`, `code_hash`, `used_at`.

**auth_tokens** (global) — `purpose` (`verify_email|magic_link|reset_password|org_invitation|guardian_invitation|athlete_account_invitation|claim_person|email_change`), `token_hash UNIQUE`, `account_id` nullable, `email citext`, `org_id` nullable, `payload jsonb`, `expires_at`, `consumed_at`, `revoked_at`, `created_by`. Resend rotates the hash; only one live token per `(purpose, email, org_id, payload subject)`.

**org_memberships** — `org_id`, `account_id`, `status` (`invited|active|suspended|removed`), `title`, `invited_by`, `joined_at`. Unique `(org_id, account_id)`. A membership gives console access only through role assignments.

**role_assignments** — `org_id`, `account_id`, `role` (see `04`), `scope_type` (`org|season|program|division|team_season`), `scope_id` nullable (null when scope_type=org), `granted_by`, `granted_at`, `revoked_at`, `pending_mfa bool`. Unique active `(org_id, account_id, role, scope_type, scope_id)`. Invariant: every org has ≥1 active owner assignment (enforced transactionally with `FOR UPDATE` on the org's owner rows).

**device_tokens** — `account_id`, `platform` (`webpush|apns|fcm`), `token_or_subscription jsonb`, `last_seen_at`, `revoked_at`.

## C. People, households, medical

**people** — `org_id`, `first_name`, `last_name`, `preferred_name`, `middle_name`, `suffix`, `date_of_birth date`, `gender` (`female|male|nonbinary|unspecified`), `competition_gender` nullable (`female|male|open` — used only for eligibility where a governing body requires it; editable only by registrar/admin, audited), `email citext`, `phone_e164`, `address jsonb`, `graduation_year int` (grade is always computed, never stored), `school_name`, `photo_file_id`, `media_consent` (`granted|denied|unknown`), `status` (`active|archived|merged|anonymized`), `merged_into_id`, `search_text` (generated), `version`. `UNIQUE(org_id, id)`.

**person_account_links** — `org_id`, `person_id`, `account_id`, `relationship` (`self|guardian`), `verified_at`, `revoked_at`. Invariants: `self` requires the person to be ≥13; at most one active `self` link per person; a person under 18 with an active `self` link must also have ≥1 active guardian link.

**households** — `org_id`, `name`, `address jsonb`, `status`. **household_members** — `org_id`, `household_id`, `person_id`, `role` (`guardian|athlete|other_adult|other_child`), `is_primary_contact bool`, `receives_communications bool`, `financially_responsible bool`, `can_pick_up bool`, `custody_note_enc` (Restricted), `lives_here bool`. A person may belong to multiple households (split custody). Unique `(household_id, person_id)`.

**emergency_contacts** — `org_id`, `person_id`, `name`, `relationship`, `phone_e164`, `alt_phone_e164`, `priority int`. At least one is required at registration for athletes (configurable per program, default on).

**medical_profiles** — `org_id`, `person_id UNIQUE`, `allergies_enc`, `allergy_flags text[]` (non-encrypted short codes such as `peanut`, `bee_sting`, `epipen`, used for coach badges), `conditions_enc`, `medications_enc`, `physician_name_enc`, `physician_phone_enc`, `insurance_carrier_enc`, `insurance_policy_enc`, `notes_enc`, `version`, `updated_by`. Every read is audited.

**form_definitions** — `org_id`, `scope` (`person_profile|registration|team_entry|volunteer|evaluation|incident|custom`), `owner_type`/`owner_id` (org, program, offering), `name`, `version int`, `schema jsonb` (`FormSchema`: fields with key, label (i18n map), type `text|textarea|number|date|select|multiselect|checkbox|file|signature|phone|email|address|heading|paragraph`, required, options, visibility conditions, sensitivity tier, applies_to `athlete|guardian|registrant`), `published_at`, `retired_at`. Published versions are immutable; editing creates a new version.

**form_responses** — `org_id`, `form_definition_id`, `definition_version`, `subject_type`/`subject_id` (person, registration, team_entry...), `answers jsonb`, `answers_enc` (for Sensitive/Restricted-tier fields), `submitted_by_account_id`, `submitted_at`, `supersedes_id`.

**waiver_documents** — `org_id`, `name`, `body_html` (sanitized), `version int`, `requires` (`guardian_if_minor|participant|both`), `renewal` (`every_registration|annual_season|once`), `published_at`, `retired_at`. Immutable once published.

**waiver_signatures** — `org_id`, `waiver_document_id`, `document_version`, `document_hash` (SHA-256 of rendered text), `participant_person_id`, `signer_account_id`, `signer_person_id`, `signer_name_typed`, `signature_file_id` nullable (drawn signature), `method` (`online_typed|online_drawn|paper_recorded_by_staff`), `registration_id` nullable, `ip`, `user_agent`, `signed_at`, `recorded_by`. Append-only.

**person_merges** — `org_id`, `survivor_id`, `merged_id`, `summary jsonb`, `performed_by`, `performed_at`. Merge moves all references in one transaction; conflicts (two active registrations in the same program) block the merge with a list.

## D. Sports, seasons, programs, teams

**sport_templates** (global) — `key UNIQUE`, `name`, `profile jsonb` (`SportProfile`, see `03`), `version`. Seeded from `shared/src/sport/templates`.

**sport_profiles** — `org_id`, `template_key` nullable, `name`, `profile jsonb`, `version`, `archived_at`. Orgs clone templates and edit; programs reference an org sport profile. Profile edits after results exist create a new version; contests store the profile version they were played under.

**seasons** — `org_id`, `name`, `starts_on`, `ends_on`, `status` (`planning|active|completed|archived`), `copied_from_season_id`. A program belongs to one season.

**programs** — `org_id`, `season_id`, `sport_profile_id`, `mode` (`league|club|class|camp|clinic|tryout|tournament|event|membership`), `name`, `slug` (unique per org), `status` (`draft|published|registration_open|registration_closed|in_progress|completed|archived`), `visibility` (`public|unlisted|private`), `starts_on`, `ends_on`, `registration_opens_at`, `registration_closes_at`, `late_registration_closes_at`, `eligibility jsonb` (`Eligibility`: age method + bounds, grades, competition gender, required membership program ids, residency rule, returning-only, invite-only, max registrations per household), `default_facility_id`, `description_html`, `settings jsonb` (`ProgramSettings`: waitlist mode `auto|manual|off`, offer expiry hours, approval required, roster visibility, public schedule/standings, min-play rule, uniform requirements, volunteer requirement id), `copied_from_program_id`, `version`.

**divisions** — `org_id`, `program_id`, `name`, `code`, `age_label` (e.g. `U10`, `12U`, `Grades 3-4`), `eligibility jsonb` (overrides program), `competition_gender`, `level` (`recreational|developmental|competitive|elite|open`), `capacity_players`, `capacity_teams`, `sort_order`. Programs without divisions use one implicit default division (always created).

**registration_offerings** — the purchasable ways to register (replaces LeagueApps "registration options"): `org_id`, `program_id`, `division_id` nullable (null = any division; division chosen by eligibility or by registrant), `name` (e.g. "Player — full season", "Goalkeeper", "Team entry", "Volunteer coach"), `registrant_role` (`athlete|coach|volunteer|team_entry|official`), `price_cents`, `pricing jsonb` (`Pricing`: early/late windows, installment plan ids, deposit cents, sibling-rule participation, GL code), `capacity`, `waitlist_enabled`, `requires_approval`, `form_definition_ids uuid[]`, `waiver_document_ids uuid[]`, `add_ons jsonb` (required/optional products e.g. uniform kit with sizes), `visibility` (`public|invite_only|staff_only`), `sort_order`, `active`.

**capacity_counters** — `org_id`, `subject_type` (`offering|division|program|class_session|evaluation_session|volunteer_shift`), `subject_id`, `capacity int` nullable, `confirmed int`, `held int`. Updated only through the capacity service (`20 §2`).

**teams** — persistent club/league identities: `org_id`, `name`, `short_name`, `sport_profile_id`, `competition_gender`, `birth_year` nullable, `age_label`, `level`, `colors jsonb`, `logo_file_id`, `status` (`active|retired`), `external_ids jsonb` (governing body team ids).

**team_seasons** — a team's participation in one program: `org_id`, `team_id`, `program_id`, `division_id`, `display_name` nullable, `roster_limit`, `roster_locked_at`, `status` (`forming|active|completed|withdrawn`), `home_facility_id`, `practice_preferences jsonb`, `version`. Unique `(team_id, program_id)`.

**roster_entries** — `org_id`, `team_season_id`, `person_id`, `registration_id` nullable (guest players may have none), `kind` (`rostered|guest|practice_only`), `jersey_number text` nullable, `positions text[]` (validated against sport profile), `status` (`active|injured|suspended|inactive|released`), `joined_on`, `left_on`. Partial unique: one active entry per `(team_season_id, person_id)`; partial unique `(team_season_id, jersey_number)` among active entries with non-null number.

**team_staff** — `org_id`, `team_season_id`, `person_id`, `role` (`head_coach|assistant_coach|team_manager|trainer|treasurer|other`), `status` (`pending_compliance|active|removed`), `added_by`. Activation requires compliance gate pass (`11` Phase 7).

**external_teams** — opponents or tournament entrants not managed by the org: `org_id`, `name`, `club_name`, `contact_name`, `contact_email`, `contact_phone`, `sport_profile_id`, `age_label`, `competition_gender`, `linked_org_id` nullable (if that club also uses Athlentry).

## E. Registration and checkout

**registrations** — `org_id`, `program_id`, `division_id`, `offering_id`, `person_id` (participant), `household_id`, `registered_by_account_id`, `source` (`online|staff|import|offer_acceptance|transfer`), `status` (`pending_payment|pending_approval|waitlisted|offered|confirmed|canceled|withdrawn|transferred_out`), `status_reason`, `team_season_id` nullable (placement), `checkout_id`, `invoice_line_id`, `transferred_from_id`, `canceled_at`, `canceled_by`, `version`. Partial unique: one registration per `(program_id, person_id)` whose status is not in (`canceled`, `withdrawn`, `transferred_out`).

**registration_status_history** — every transition with actor and reason.

**checkouts** (a cart) — `org_id`, `account_id`, `status` (`open|awaiting_payment|completed|expired|abandoned|failed`), `expires_at` (20 minutes after last activity for capacity holds), `items jsonb` (validated snapshot), `pricing_snapshot jsonb` (all computed lines, discounts, fees; frozen at `awaiting_payment`), `payment_plan_choice`, `payment_intent_id`, `idempotency_key`, `completed_at`.

**capacity_holds** — `org_id`, `checkout_id`, `subject_type`, `subject_id`, `quantity`, `expires_at`, `released_at`, `converted_at`.

**waitlist_entries** — `org_id`, `offering_id`, `person_id`, `household_id`, `position int`, `status` (`waiting|offered|accepted|expired|declined|removed`), `offered_at`, `offer_expires_at`, `registration_id`. Unique active per `(offering_id, person_id)`.

**registration_approvals** — `registration_id`, `decision` (`approved|declined`), `decided_by`, `note`, `decided_at`.

**team_entries** — a team registering into a league/tournament program: `org_id` (owner of the program), `program_id`, `division_id`, `offering_id`, `team_season_id` nullable (internal team) or `external_team_id`, `entrant_org_id` nullable (federation member club), `captain_person_id`/`contact_account_id`, `status` (`pending_payment|pending_approval|accepted|waitlisted|withdrawn|declined`), `seed_hint int`, `invoice_id`.

**transfers** — `org_id`, `from_registration_id`, `to_registration_id`, `financial_treatment` (`carry_payment|refund_difference|charge_difference|no_change`), `performed_by`, `idempotency_key`, `result jsonb`.

## F. Evaluations and team formation

**evaluation_events** — `org_id`, `program_id` (the tryout program), `target_program_id` (the season the placements feed), `name`, `rubric jsonb` (`Rubric`: criteria with key, label, scale min/max, weight, position-specific flag), `normalization` (`none|z_score_per_evaluator`), `status` (`setup|live|closed|finalized`).

**evaluation_sessions** — `org_id`, `evaluation_event_id`, `event_id` (calendar), `group_label`, `capacity`. **evaluation_session_athletes** — session, person, `bib_number`, `checked_in_at`.

**evaluator_assignments** — `org_id`, `evaluation_session_id`, `account_id`, `criteria_keys text[]` nullable (null = all).

**evaluation_scores** — `org_id`, `evaluation_session_id`, `evaluator_account_id`, `person_id`, `criterion_key`, `score numeric(5,2)`, `note`, `recorded_at`, `client_mutation_id` (offline sync idempotency). Unique `(session, evaluator, person, criterion)` (upsert).

**evaluation_results** (materialized on close) — `person_id`, `composite numeric`, `rank_in_group`, `criterion_breakdown jsonb`, `evaluator_count`.

**placement_boards** — `org_id`, `evaluation_event_id`, `target_program_id`, `status` (`draft|published`), `constraints jsonb`. **placements** — board, person, `team_season_id`, `locked bool`, `note`.

**team_offers** — `org_id`, `person_id`, `team_season_id`, `offering_id` (defines fee/deposit), `status` (`draft|sent|accepted|declined|expired|rescinded`), `expires_at`, `message`, `sent_at`, `responded_at`, `registration_id` (created on acceptance), `responded_by_account_id`.

## G. Compliance and safety

**credential_types** — `org_id` nullable (null = platform-provided defaults the org can adopt), `key`, `name`, `description`, `verification` (`document_upload|attestation|provider|manual_staff`), `provider` nullable (`checkr`), `validity` jsonb (`months` N or `expires_on_month_day` e.g. `08-31` or `never`), `applies_to` jsonb (roles, minimum age e.g. athletes ≥18 for SafeSport), `blocks_activation bool`, `renewal_reminder_days int[]` default `{30,14,3}`, `active`.

**role_credential_requirements** — `org_id`, `role` (team staff role, official, volunteer role, evaluator), `credential_type_id`, `scope_type`/`scope_id` (org|program).

**person_credentials** — `org_id`, `person_id`, `credential_type_id`, `status` (`pending_review|verified|rejected|expired|revoked`), `identifier_enc` (license/membership number), `issued_on`, `expires_on`, `file_id`, `verified_by`, `verified_at`, `rejection_reason`, `provider_reference`, `version`.

**background_check_orders** — `org_id`, `person_id`, `provider` (`manual|checkr`), `package`, `status` (`consent_pending|invited|in_progress|clear|consider|suspended|canceled|expired`), `consent_signed_at`, `disclosure_version`, `provider_candidate_id`, `provider_report_id`, `result_summary` (`clear|consider|adverse_action`), `details_enc`, `adjudication` (`eligible|ineligible|pending`), `adjudicated_by`, `adjudicated_at`, `pre_adverse_notice_at`, `adverse_notice_at`, `completed_at`, `credential_id` (the credential it satisfies). FCRA flow: consent/disclosure is captured before ordering; a "consider" result requires pre-adverse notice + 5 business days before an adverse decision.

**injury_reports** — `org_id`, `person_id`, `event_id` nullable, `occurred_at`, `body_part`, `injury_type`, `is_suspected_concussion bool`, `description_enc`, `reported_by`, `guardian_notified_at`, `status` (`open|return_to_play_pending|cleared|closed`). **return_to_play_clearances** — injury, `clearance_file_id`, `cleared_by_provider_name`, `cleared_on`, `recorded_by`. A suspected concussion sets the athlete's roster entries to `injured` (blocks lineup/check-in) until clearance is recorded.

**incident_reports** — `org_id`, `category` (`safety|behavior|safesport_concern|facility|other`), `occurred_at`, `event_id`, `people_involved uuid[]`, `narrative_enc`, `reported_by`, `status` (`open|under_review|closed`), `restricted bool` (SafeSport concerns are restricted to compliance officers and owners), `resolution_enc`.

**athlete_cards** — generated player/coach ID cards: `org_id`, `person_id`, `program_id` or `season_id`, `card_number`, `qr_secret`, `photo_file_id`, `status` (`active|revoked`), `valid_until`. QR encodes a signed URL resolving to a minimal verification page (name, photo, team, validity; no other PII).

## H. Facilities and scheduling

**facilities** — `org_id`, `name`, `address jsonb`, `lat`, `lng`, `timezone` nullable (defaults to org), `ownership` (`owned|permitted|partner`), `notes_html`, `parking_notes`, `map_url`, `public bool`, `archived_at`.

**spaces** — bookable units: `org_id`, `facility_id`, `parent_space_id` nullable (split fields: full → halves → quarters), `name`, `kind` (`field|court|rink|pool|lanes|mat|diamond|track|room|other`), `surface`, `has_lights bool`, `suitability jsonb` (sport profile ids, age labels, min/max field size), `capacity_people`, `archived_at`. Booking a parent space blocks its children and vice versa.

**space_availability** — windows when the org may use a space: `org_id`, `space_id`, `rrule text` (RFC 5545), `starts_on`, `ends_on`, `start_time`, `end_time`, `source` (`owned|permit`), `permit_reference`, `cost_per_hour_cents`.

**space_blackouts** — `space_id` or `facility_id`, `starts_at`, `ends_at`, `reason`.

**space_bookings** — every occupied time on a space (events and allocations write here): `org_id`, `space_id`, `during tstzrange`, `event_id` nullable, `allocation_id` nullable. Exclusion constraint `EXCLUDE USING gist (space_id WITH =, during WITH &&)` on each booked leaf plus trigger-expanded parent/child rows so split-field conflicts are impossible at the database level.

**allocations** — recurring practice blocks: `org_id`, `space_id`, `team_season_id` nullable or `division_id` nullable, `rrule`, `starts_on`, `ends_on`, `start_time`, `end_time`, `purpose` (`practice|games|clinic|other`), `status`.

**closures** — `org_id`, `scope_type` (`facility|space|org`), `scope_id`, `starts_at`, `ends_at`, `reason` (`weather|maintenance|permit|other`), `message`, `created_by`, `notified_at`, `affected_event_ids uuid[]`.

**events** — every calendar item: `org_id`, `program_id` nullable, `division_id` nullable, `kind` (`game|practice|meet|match|bout_session|class_session|evaluation_session|tournament_game|meeting|volunteer_shift|other`), `title`, `starts_at`, `ends_at`, `timezone`, `space_id` nullable, `location_text` (when not at an org space), `status` (`scheduled|postponed|canceled|completed`), `status_reason`, `published bool`, `series_id` nullable (recurrence), `generation_run_id` nullable, `notes_html`, `arrival_minutes_before int`, `version`.

**event_participants** — which teams/people/divisions an event is for: `event_id`, `team_season_id` or `external_team_id` or `person_id` or `division_id`, `side` (`home|away|none`).

**schedule_generation_runs** — `org_id`, `program_id`, `input jsonb` (`GeneratorInput`), `seed bigint`, `status` (`queued|running|succeeded|failed|applied|discarded`), `result jsonb` (draft events + violations + score), `created_by`, `applied_at`.

**reschedule_requests** — `org_id`, `event_id`, `requested_by`, `reason`, `proposed_slots jsonb`, `status` (`open|approved|declined|withdrawn`), `decided_by`, `resulting_event_id`.

**calendar_feeds** — `account_id` or `team_season_id`, `token_hash`, `scope jsonb`, `revoked_at` (ICS subscription URLs).

## I. Contests, results, stats, standings

**contests** — the competitive part of an event: `org_id`, `event_id UNIQUE`, `sport_profile_id`, `profile_version`, `format` (from sport profile: `head_to_head_score|head_to_head_sets|head_to_head_bout|multi_timed|multi_measured|judged|placement_only`), `stage` (`regular|pool|playoff|championship|consolation|friendly|exhibition`), `counts_for_standings bool`, `bracket_match_id` nullable, `status` (`scheduled|in_progress|final|forfeit|canceled|abandoned`), `result_entered_by`, `result_confirmed_by`, `finalized_at`, `version`.

**contest_participants** — `contest_id`, `team_season_id` | `external_team_id` | `person_id`, `side` (`home|away|none`), `lane`, `heat`, `flight`, `seed`, `entry_meta jsonb`.

**contest_results** — one row per participant: `contest_participant_id`, `outcome` (`win|loss|tie|none`), `place int`, `score numeric` (primary: goals/points/strokes/total), `score_detail jsonb` (`ScoreDetail` by format: periods, sets with points, time in ms, marks with units, judge panels, bout method), `status` (`ok|dnf|dns|dq|forfeit_win|forfeit_loss|no_contest`), `points_awarded numeric` (for team scoring in meets).

**stat_lines** — `org_id`, `contest_id`, `person_id` nullable, `team_season_id` nullable, `stat_key` (from profile), `value numeric`. Unique `(contest_id, person_id/team, stat_key)`.

**result_audit** — every result edit with before/after and actor (results are disputed often).

**standings_configs** — `org_id`, `program_id` or `division_id`, `config jsonb` (`StandingsConfig`, see `03 §5`). **standings_snapshots** — computed tables cached after each finalized result: `scope`, `computed_at`, `rows jsonb`.

**brackets** — `org_id`, `program_id`, `division_id`, `name`, `type` (`single_elim|double_elim|round_robin_pools|pools_to_bracket|consolation|ladder`), `size`, `seeding_source` (`manual|standings|pool_results|random`), `third_place bool`, `status` (`draft|published|in_progress|completed`), `config jsonb`. **bracket_matches** — `bracket_id`, `round`, `position`, `winner_to_match_id`/`winner_to_slot`, `loser_to_match_id`/`loser_to_slot`, `participant_a`, `participant_b` (team_season/external/person or `null` = bye/TBD), `contest_id`.

**pools** / **pool_members** for pool play.

**lineups** — `contest_id`, `team_season_id`, `entries jsonb` (person, position, batting/serve order, starter flag), `submitted_by`, `locked_at`.

**playing_time** — `contest_id`, `person_id`, `periods_played int[]` or `minutes numeric` (for min-play rules).

**game_reports** — `contest_id`, `submitted_by`, `role` (`official|coach|site_director`), `body_html`, `incidents jsonb`, `submitted_at`.

**discipline_records** — `org_id`, `person_id` or `team_season_id`, `contest_id`, `type` (`caution|send_off|ejection|technical|suspension|fine|other`), `description`, `suspension_games int`, `suspension_until date`, `games_served int`, `status` (`active|served|appealed|overturned`), `issued_by`. Active suspensions block lineup inclusion and flag the roster.

## J. Officials

**official_profiles** — `org_id`, `person_id`, `grade/level`, `sports uuid[]`, `max_games_per_day`, `home_area`, `travel_radius_km`, `pay_rates jsonb`, `active`. **official_availability** — `person_id`, `rrule` or date ranges, `available bool`.

**official_positions** (per sport profile, e.g. referee, AR1, AR2, umpire plate/base, scorekeeper, timer, line judge).

**official_assignments** — `org_id`, `contest_id`, `position_key`, `person_id`, `status` (`offered|accepted|declined|confirmed|canceled|no_show`), `fee_cents`, `mileage_cents`, `assigned_by`, `responded_at`. Unique `(contest_id, position_key)` among non-canceled.

**official_pay_batches** — `org_id`, `period_start`, `period_end`, `status` (`draft|approved|paid`), `paid_via` (`external|check|other`), `paid_at`; **official_pay_lines** — batch, person, assignments, amounts. Yearly totals report per person with a configurable 1099 threshold (default $2,000, owner must confirm with an accountant). No TINs are stored.

## K. Volunteers

**volunteer_roles** — `org_id`, `name`, `description`, `credential_requirements` (through `role_credential_requirements`), `minimum_age`.

**volunteer_requirements** — `org_id`, `season_id` or `program_id`, `unit` (`hours|shifts`), `amount_per_household` or `amount_per_athlete`, `buyout_price_cents` nullable, `buyout_offering_id`, `deadline`.

**volunteer_shifts** — `org_id`, `volunteer_role_id`, `event_id` nullable, `facility_id`, `starts_at`, `ends_at`, `slots int`, `credit_hours numeric`, `notes`.

**volunteer_signups** — `org_id`, `volunteer_shift_id`, `person_id`, `household_id`, `status` (`signed_up|confirmed|checked_in|completed|no_show|canceled`), `hours_credited numeric`, `credited_by`.

**volunteer_ledger** (view or materialized) per household per requirement: required, completed, bought out, remaining.

## L. Finance

**payment_accounts** — `org_id UNIQUE`, `provider` (`stripe`), `stripe_account_id`, `charges_enabled`, `payouts_enabled`, `details_submitted`, `requirements jsonb`, `statement_descriptor`, `default_currency`, `onboarding_status`.

**payer_profiles** (global, platform-level) — `account_id UNIQUE`, `stripe_customer_id`.

**payment_methods** (global) — `account_id`, `stripe_payment_method_id`, `type` (`card|us_bank_account|link`), `brand`, `last4`, `exp_month`, `exp_year`, `bank_name`, `is_default`, `status` (`active|detached|failed_verification`).

**autopay_authorizations** — `org_id`, `account_id`, `payment_method_id`, `invoice_id` or `subscription_id` (class tuition), `mandate_text_version`, `authorized_at`, `revoked_at`, `ip`, `user_agent`. Required before any off-session charge.

**installment_plan_templates** — `org_id`, `name`, `kind` (`fixed_dates|monthly|weekly`), `deposit jsonb`, `schedule jsonb` (dates or count/interval), `min_amount_cents`, `autopay_required bool`, `allowed_methods`.

**invoices** — `org_id`, `number` (org counter), `account_id` (bill-to), `household_id`, `status` (`draft|open|paid|partially_paid|past_due|void|uncollectible`), `issued_at`, `due_on`, `currency`, `subtotal_cents`, `discount_cents`, `service_fee_cents`, `tax_cents`, `total_cents`, `paid_cents`, `refunded_cents`, `credit_applied_cents`, `balance_cents` (generated: total − paid − credit + refunded-if-reopened rules in `20`), `memo`, `source` (`checkout|staff|installment_rollover|team_fee|tuition|order|donation`), `voided_at`, `void_reason`, `version`. Invariant enforced by trigger + tests: sums of lines, allocations and refunds reconcile with header totals.

**invoice_lines** — `org_id`, `invoice_id`, `kind` (`registration|add_on|product|team_fee|tuition|volunteer_buyout|donation|service_fee|late_fee|adjustment|discount|aid`), `description`, `quantity`, `unit_amount_cents`, `amount_cents` (signed; discounts negative), `registration_id`, `person_id`, `program_id`, `team_season_id`, `product_variant_id`, `gl_code`, `tax_rate_bps`, `refundable bool`, `parent_line_id` (discount/fee attached to a line).

**installments** — `org_id`, `invoice_id`, `sequence`, `due_on`, `amount_cents`, `paid_cents`, `status` (`scheduled|processing|paid|failed|canceled|waived`), `autopay bool`, `payment_method_id`, `attempt_count`, `next_attempt_at`, `last_failure_code`, `last_failure_message`.

**payments** — `org_id`, `account_id` nullable (staff-recorded cash/check may have none), `method` (`card|us_bank_account|link|apple_pay|google_pay|cash|check|external`), `status` (`requires_action|processing|succeeded|failed|canceled`), `amount_cents`, `application_fee_cents`, `processing_fee_cents` (from balance transaction), `net_cents`, `stripe_payment_intent_id UNIQUE`, `stripe_charge_id`, `reference` (check number), `received_by` (staff), `idempotency_key`, `failure_code`, `failure_message`, `succeeded_at`.

**payment_allocations** — `payment_id`, `invoice_id`, `installment_id` nullable, `amount_cents`. Sum per payment = payment amount (on success).

**refunds** — `org_id`, `payment_id`, `amount_cents`, `reason` (`requested_by_customer|duplicate|fraudulent|program_canceled|withdrawal_policy|other`), `note`, `status` (`pending|succeeded|failed|canceled`), `stripe_refund_id`, `refund_application_fee bool`, `reverse_transfer bool` (always true for destination charges unless platform absorbs), `allocations jsonb` (which invoice lines), `requested_by`, `approved_by` (two-person approval when above org threshold).

**disputes** — `org_id`, `payment_id`, `stripe_dispute_id`, `status`, `reason`, `amount_cents`, `evidence_due_by`, `evidence_submitted_at`, `outcome`. Evidence packet builder pulls registration, waiver signature, attendance and communications.

**credits** (ledger) — `org_id`, `account_id`/`household_id`, `amount_cents` (signed), `kind` (`issued|applied|expired|reversed`), `source` (refund-as-credit, goodwill, overpayment), `invoice_id`, `expires_on`, `note`, `created_by`. Balance = sum.

**discount_codes** — existing concept: `code citext`, `kind` (`fixed|percent`), `value`, `applies_to jsonb` (programs/offerings/products), `starts_at`, `ends_at`, `max_redemptions`, `max_per_account`, `stackable bool`, `active`. **discount_redemptions**.

**automatic_discount_rules** — `org_id`, `kind` (`sibling|multi_program|returning|early_bird_override|staff_child|volunteer_coach_child`), `config jsonb` (e.g. sibling: 2nd child 10%, 3rd+ 15%; applies to offering set; ordering = highest price first gets no discount), `season_id` scope, `priority`, `stackable bool`, `active`.

**financial_aid_programs** — `org_id`, `name`, `season_id`, `application_form_id`, `budget_cents`, `awarded_cents`, `status`. **aid_applications** — household, programs, `requested_cents`, `answers`, `documents`, `status` (`submitted|under_review|awarded|partially_awarded|declined|withdrawn`), `award_cents`, `award_kind` (`percent|fixed`), `decided_by`. Awards apply as `aid` invoice lines (confidential: only finance/owner see aid details; families see only their own).

**payouts** (mirror) — `org_id`, `stripe_payout_id`, `amount_cents`, `arrival_date`, `status`, `balance_transaction_ids`. **balance_transactions** (mirror) — for reconciliation reports.

**stripe_events** — `stripe_event_id UNIQUE`, `account` (connected account id or platform), `type`, `payload jsonb`, `received_at`, `processed_at`, `error`, `attempts`.

**tax_rates** — `org_id`, `name`, `rate_bps`, `applies_to` (`products` only; registrations are not taxed by default), `active`.

**gl_codes** — `org_id`, `code`, `name`, `kind` (`income|liability|expense`). Used by offerings, products, fees, donations for accounting export.

## M. Team finance, fundraising, sponsors, store

**team_ledgers** — `org_id`, `team_season_id UNIQUE`, `budget_cents`, `status`. **team_ledger_entries** — `org_id`, `team_ledger_id`, `direction` (`income|expense`), `category`, `amount_cents`, `occurred_on`, `memo`, `receipt_file_id`, `source` (`team_fee_payment|manual|reimbursement`), `payment_id` nullable, `created_by`, `approved_by`, `approved_at`. **team_fee_assessments** — team_season, per-player amount, due date, installment template; generates invoices with `team_fee` lines whose GL code maps to the team ledger. **reimbursement_requests** — requester, amount, receipt, status, approver.

**fundraising_campaigns** — `org_id`, `name`, `slug`, `goal_cents`, `starts_at`, `ends_at`, `team_season_id` nullable, `description_html`, `image_file_id`, `status`, `show_donor_names bool`. **donations** — `org_id`, `campaign_id`, `donor_account_id` nullable, `donor_name`, `donor_email`, `amount_cents`, `anonymous bool`, `dedication`, `payment_id`, `receipt_number`, `receipt_sent_at`, `quid_pro_quo_value_cents` (default 0).

**sponsors** — `org_id`, `name`, `contact`, `logo_file_id`, `website_url`, `tier`, `amount_cents`, `contract_start`, `contract_end`, `placements jsonb` (website homepage, program pages, team pages, emails), `invoice_id`, `status`.

**products**, **product_variants**, **inventory_movements** (ledger: receive, reserve, release, sell, adjust), **orders**, **order_lines**, **fulfillments** — port existing commerce with these changes: orders produce invoices through the finance module; inventory is a ledger (current stock = sum); registration add-ons create order lines tied to the registration; **uniform size report** groups add-on order lines by team_season and size for vendor ordering.

## N. Communications

**message_campaigns** — `org_id`, `author_account_id`, `channels text[]` (`email|sms|push|in_app`), `subject`, `body_html`, `body_text`, `sms_text`, `locale_variants jsonb`, `audience jsonb` (`AudienceSpec`, see below), `category` (`operational|announcement|marketing|emergency`), `status` (`draft|scheduled|sending|sent|canceled|failed`), `scheduled_for`, `sent_at`, `resolved_recipient_count`, `reply_to`.

`AudienceSpec` = union of selectors combined with include/exclude: program, division, team_season, role (athletes' guardians, coaches, officials, volunteers, board), season, registration status, balance past due, missing waiver/form, non-compliant staff, unsigned volunteer requirement, evaluation group, household ids, person ids, saved segment. Recipients resolve to accounts/addresses at send time; the resolved list is stored.

**message_deliveries** — `org_id`, `campaign_id` or `notification_id`, `recipient_account_id`, `person_id` (about whom), `channel`, `address`, `status` (`queued|suppressed|sending|sent|delivered|bounced|complained|failed|opened|clicked`), `provider_message_id`, `error`, timestamps. Unique `(campaign_id, recipient_account_id, channel)`.

**suppressions** — `org_id` nullable (global for hard bounces/complaints), `channel`, `address`, `reason` (`unsubscribe|bounce|complaint|stop|manual`), `created_at`.

**communication_preferences** — `account_id`, `org_id`, `category`, `channel`, `enabled`. Operational/emergency categories cannot disable every channel (at least one stays on).

**notification_types** (code-defined catalog) and **notifications** — `account_id`, `org_id`, `type`, `payload jsonb`, `read_at`, `delivered_channels text[]`.

**conversations** — `org_id`, `kind` (`team|team_staff|announcement|group|direct`), `team_season_id` nullable, `title`, `created_by`, `archived_at`. **conversation_members** — conversation, account, `role` (`owner|member|read_only`), `muted`, `last_read_at`. **chat_messages** — conversation, author, `body`, `attachments`, `edited_at`, `deleted_at`, `deleted_by`, `reported_count`. **chat_reports** — message, reporter, reason, status. SafeSport rules in `04 §4`.

**message_templates** — `org_id`, `name`, `channel`, `subject`, `body`, `locale`.

## O. Website

Port existing `website_pages`, `website_revisions`, `website_settings`, menus, assets, with: `news_posts` (title, slug, body, cover, published_at, author), `contact_submissions` (Turnstile-verified, routed to an org inbox email), auto-generated pages (programs, program detail, schedule, standings, brackets, teams (media-consent aware), sponsors, fundraisers, facilities with maps, staff directory opt-in), `embed_widgets` (program list, schedule, standings, registration button) for orgs keeping an external website.

## P. Classes (academy mode)

**class_offerings** — `org_id`, `program_id` (mode `class`), `name`, `level_id`, `age_min_months`, `age_max_months`, `capacity`, `instructor_ratio`, `billing` (`term|monthly|drop_in|punch_card`), `price_cents`, `tuition_tiers jsonb` (price by classes per week per household), `trial_allowed bool`, `makeup_policy jsonb`.

**class_schedules** — offering, `rrule`, `start_time`, `duration_minutes`, `space_id`, `instructor_person_ids`, `term_start`, `term_end`. Generates `events` (kind `class_session`).

**class_enrollments** — `org_id`, `class_offering_id`, `person_id`, `status` (`trial|active|paused|withdrawn|waitlisted`), `starts_on`, `ends_on`, `billing_subscription_id`.

**tuition_subscriptions** — `org_id`, `account_id`, `household_id`, `status`, `billing_day int` (1–28), `payment_method_id`, `next_bill_on`, `proration` rule, `paused_until`. Generates monthly invoices through `classes.tuition` job (our scheduler, not Stripe Billing, so all money flows through one engine).

**makeup_credits** — `person_id`, `class_offering_id`, `source_event_id`, `expires_on`, `used_event_id`.

**skill_levels** — `org_id`, `sport_profile_id`, `name`, `order`, `skills` (child table **skills**: name, description, video_url). **athlete_skill_records** — person, skill, `status` (`not_started|in_progress|achieved`), `assessed_by`, `assessed_at`, `note`. **level_promotions** — person, from, to, date, by. Progress visible to guardians.

## Q. Attendance

**attendance** — `org_id`, `event_id`, `person_id`, `rsvp` (`yes|no|maybe|none`), `rsvp_by_account_id`, `status` (`present|absent|late|excused|unknown`), `checked_in_at`, `checked_in_by`, `checked_out_at`, `picked_up_by_person_id` (academy pickup verification), `version`. Roster snapshot on first write (port existing snapshot concept).

## R. Imports, exports, reports

**import_batches** — `org_id`, `kind` (`people|households|registrations|teams|rosters|schedule|facilities|credentials|historical_payments`), `file_id`, `mapping jsonb`, `mapping_preset_id`, `status` (`uploaded|mapped|validated|committing|committed|failed|rolled_back`), `row_count`, `error_count`, `summary jsonb`, `created_by`, `committed_at`. **import_rows** — batch, row number, raw jsonb, normalized jsonb, `issues jsonb`, `action` (`create|update|merge|skip`), `target_id`. Commit is transactional per batch and reversible (`rolled_back` deletes created rows only if untouched since import).

**mapping_presets** — `org_id` nullable (global), `kind`, `name`, `mapping jsonb`.

**saved_reports** — `org_id`, `owner_account_id`, `dataset`, `definition jsonb` (`ReportDefinition`: columns, filters, grouping, aggregates, sort), `shared_with_roles text[]`, `schedule jsonb` (cron-like weekly/monthly + recipients), `last_run_at`.

**data_exports** — `org_id`, `requested_by`, `scope`, `status`, `file_id`, `expires_at`.

**privacy_requests** — `org_id`, `subject_person_id`/`account_id`, `kind` (`access|deletion|correction`), `status`, `handled_by`, `completed_at`, `notes`.
