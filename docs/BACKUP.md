# Backup and restore

Fieldhouse stores records, uploaded website images and private form attachments in SQLite. A database snapshot includes those files. Keep deployment configuration and secrets separately; the snapshot does not include environment variables, application code or provider configuration.

## Create a backup

From the project directory, with the destination directory already created:

```sh
npm run db:copy -- data/fieldhouse.sqlite /absolute/backup/path/fieldhouse-2026-09-09.sqlite
```

Use your configured `DATABASE_PATH` as the source if it differs from the default. Choose a new destination each time. The command uses SQLite `VACUUM INTO` to capture committed data consistently, including committed WAL records, while the application may remain running. It checks integrity and foreign keys before and after copying and restricts the resulting file to its owner. It does not copy an uncommitted transaction.

Store backups outside the application machine as part of deployment operations, protect them as private account data, and define retention appropriate to your organization. Automated scheduling and remote storage are not configured by this command.

## Restore without destroying the current database

1. Stop the application and any message-delivery worker. Keep the original database and its sidecar files intact.
2. Validate and copy a chosen backup into a new database file:

```sh
npm run db:copy -- /absolute/backup/path/fieldhouse-2026-09-09.sqlite data/restored-2026-09-09.sqlite
```

3. Start the application using that new file:

```sh
DATABASE_PATH=data/restored-2026-09-09.sqlite npm run dev
```

For a built deployment, set the same `DATABASE_PATH` in its environment and use `npm start`. Use the application version associated with the backup first; newer versions may apply migrations on opening it.

4. Check organization identity, representative member/registration/invoice records, and a stored attachment before reopening access. Retain the previous database until the restore is accepted. To revert, stop the application and switch `DATABASE_PATH` back to the preserved original.

A restored database represents its snapshot time. Later records are absent. External payments and sent messages are not reversed by restoring SQLite: reconcile them before enabling delivery or processing further transactions. Keep delivery disabled during restore verification.

## Verification evidence

`server/database-copy.test.mjs` creates a real SQLite database, backs it up while open, changes the source, restores the backup to a new file, and verifies the original snapshot's records and embedded bytes. It also checks destination permissions and refusal to overwrite existing files. This tests the procedure with fictional data; it does not claim remote backup storage or a production disaster-recovery drill is configured.
