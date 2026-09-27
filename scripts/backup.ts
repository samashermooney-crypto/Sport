import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createEncryptedBackup,
  uploadEncryptedBackup,
} from '../server/src/lib/observability/backup.js';

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  createEncryptedBackup()
    .then(async (path) => {
      const objectKey = await uploadEncryptedBackup(path);
      if (process.env.NODE_ENV === 'production' && !objectKey)
        throw new Error(
          'Production backups require configured BACKUP_S3_* storage',
        );
      process.stdout.write(`Encrypted backup written: ${path}\n`);
      if (objectKey)
        process.stdout.write(`Encrypted backup uploaded: ${objectKey}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'Encrypted backup failed'}\n`,
      );
      process.exitCode = 1;
    });
}
