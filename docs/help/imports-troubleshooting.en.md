---
title: "Troubleshooting imports"
summary: "Common import errors and how to fix them."
category: "Imports"
audience: "admin"
order: 12
---
# Troubleshooting imports

## "Missing required column"

The validator lists the columns it could not find. Open the mapping step and point each required field at the right column in your file, or add the column to the file. Saving the corrected mapping as a preset means you will not have to fix it again.

## Rows marked as duplicates

A duplicate means the row's dedupe key (usually name + birth date for people, or name + season for teams) already exists in your organization. For each duplicate choose **create** (add anyway), **update** (fill empty fields on the existing record), **merge**, or **skip**.

## Rows skipped during commit

Rows with validation errors are skipped, not aborted — the rest of the batch still commits. Fix the listed rows in your file and run a second import; committed rows are not duplicated because the new file only contains the fixes.

## Schedule rows that cannot find a team or facility

Schedule imports match teams and facilities by name. Import facilities first, and make sure team names in the file match the names created by the Teams import exactly (case does not matter). Unmatched facilities are created automatically and flagged as warnings.

## Rollback

**Imports → [batch] → Roll back** removes everything the batch created. Records changed since the import are left untouched — rollback only removes data that is still exactly as the import wrote it.
