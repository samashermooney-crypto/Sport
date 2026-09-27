import { pathToFileURL } from 'node:url';

import { createDatabase } from '../server/src/db/kysely';
import { parseEncryptionKeys } from '../server/src/lib/crypto';
import { rotateEncryptedData } from '../server/src/lib/security/encryption-rotation';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--apply'))
    throw new Error(
      'Usage: node --import tsx scripts/rotate-encryption-key.ts [--apply]',
    );
  const dryRun = !args.includes('--apply');
  const keyJson = process.env.DATA_ENCRYPTION_KEYS;
  const activeKid = process.env.DATA_ENCRYPTION_ACTIVE_KID;
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!keyJson || !activeKid || !adminUrl)
    throw new Error(
      'DATABASE_ADMIN_URL, DATA_ENCRYPTION_KEYS and DATA_ENCRYPTION_ACTIVE_KID are required',
    );
  const encryption = parseEncryptionKeys(keyJson, activeKid);
  const database = createDatabase(adminUrl);
  try {
    const summary = await rotateEncryptedData(database, encryption, { dryRun });
    process.stdout.write(
      `${dryRun ? 'Dry run' : 'Applied'}: examined ${String(summary.rowsExamined)} encrypted values; ${String(summary.rowsNeedingRotation)} need rotation; rotated ${String(summary.rowsRotated)}.\n`,
    );
  } finally {
    await database.destroy();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Key rotation failed'}\n`,
    );
    process.exitCode = 1;
  });
}
