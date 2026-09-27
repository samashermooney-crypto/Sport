---
title: 'Switch to Athlentry from LeagueApps'
summary: 'Step-by-step migration guide: export your LeagueApps data, import it, and go live.'
category: 'Switch to Athlentry'
audience: 'admin'
order: 20
---

# Switch to Athlentry from LeagueApps

Moving from LeagueApps takes about a weekend for most organizations. You never need to give anyone your LeagueApps login — everything moves through exports.

## Before you start

- Finish the onboarding checklist items for payments, sports, and compliance first. Imports match against the structure you create.
- Plan your cutover for between seasons if you can. Historical imports are safe any time; open registration last.

## Step 1 — Export from LeagueApps

From your LeagueApps admin console, export:

- **Members/players** (CSV export from the Members report) → Athlentry _People_ import.
- **Teams and rosters** → _Teams_ then _Rosters_ imports.
- **Schedule/games** → _Schedule_ import (create your facilities first).
- **Payment history** → _Payment history_ import. These are recorded as external payments — they appear on family balances for history but are never charged again.
- LeagueApps does not export signed waivers — have families re-sign waivers when they register for their first Athlentry program.

## Step 2 — Import into Athlentry

Go to **Console → Imports**. For each export: upload the file, confirm the column mapping (save it as a preset), validate, review duplicates, and commit. Follow the order in _Importing your data_.

## Step 3 — Recreate your programs

Use the program wizard to recreate current-season programs. Map old LeagueApps program names in the registration import so history lands on the right program.

## Step 4 — Go live

Publish your Athlentry website, update the link from your old LeagueApps site, and open registration. Keep your LeagueApps account read-only for one season as a reference.

## Prefer help?

Choose **Concierge import** on the Imports page or from Help → Contact support. Send us your export files and our team performs the migration with you on a call.
