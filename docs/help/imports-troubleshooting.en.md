---
title: 'Import troubleshooting'
summary: 'Resolve column mapping, validation, duplicate, and rollback questions.'
category: 'Imports'
audience: 'admin'
order: 13
---

# Import troubleshooting

**A required field is unmapped.** Return to Map columns and choose the column containing that value. The generic template is a guide; exported headers can differ.

**A row has a validation error.** Read the row issue, correct the source value, and upload a corrected copy. Rows with errors are skipped at commit.

**A person looks like a duplicate.** Compare the displayed match details. Choose Create new only when the records are different people; otherwise choose Skip row. Do not merge a child record based only on a name.

**A credential document is missing.** The document name must match a file in the uploaded ZIP. Use one CSV and include each allowed PDF or image under its file name.

**Rollback leaves a record untouched.** The record changed after import or another record depends on it. Review the batch summary and resolve the dependency before trying again. Financial and compliance evidence remains retained.
