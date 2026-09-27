---
title: 'Importing your data'
summary: 'Bring people, rosters, schedules, facilities, credentials, payment history, and volunteer hours in from spreadsheets.'
category: 'Imports'
audience: 'admin'
order: 10
---

# Importing your data

Athlentry imports CSV and Excel (.xlsx) files, plus ZIP archives of documents for credential imports. Go to **Console → Imports** and choose what you are importing.

## What you can import

| Import          | Notes                                                                               |
| --------------- | ----------------------------------------------------------------------------------- |
| People          | Players, guardians, and household contacts, with emergency contacts.                |
| Households      | Family groupings with billing relationships.                                        |
| Registrations   | Historical registrations, matched to programs.                                      |
| Teams           | Teams within a season or division.                                                  |
| Rosters         | Team assignments for players and coaches.                                           |
| Schedule        | Games and events, matched to teams and facilities.                                  |
| Facilities      | Fields, courts, and venues.                                                         |
| Credentials     | Staff certifications and background checks, with expiry dates and zipped documents. |
| Payment history | Historical payments recorded as _external_ — they are never re-charged.             |
| Volunteer hours | Past volunteer service records.                                                     |

## How an import works

1. **Upload** your CSV, XLSX, or ZIP file.
2. **Map columns** — Athlentry suggests a mapping automatically; adjust it and save it as a preset for next time.
3. **Validate** — every row is checked and normalized. Rows with errors are listed so you can fix the file and re-upload, or skip them.
4. **Review duplicates** — rows that match existing people or teams are flagged; choose create, update, merge, or skip per row.
5. **Commit** — records are created inside your organization. A batch record keeps exactly what was created.
6. **Rollback** — if something looks wrong, roll back a committed batch. Rollback is version-safe: records you edited since the import are skipped rather than overwritten.

Download a template from the Imports page to see the exact columns for each import type.

## Tips

- Import **facilities before schedules** and **people before rosters** — later imports match against records you created earlier.
- Phone numbers are normalized to E.164; unparseable numbers are kept as warnings, not errors.
- Credential documents inside a ZIP are stored against the imported credential automatically.
