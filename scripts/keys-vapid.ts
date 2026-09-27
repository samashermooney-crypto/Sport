import { createECDH } from 'node:crypto';
import { chmod, mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const destination = resolve(
  process.argv[2] ?? 'data/generated-vapid-keys.json',
);

export async function generateVapidKeyFile(
  path = destination,
): Promise<string> {
  const key = createECDH('prime256v1');
  key.generateKeys();
  const document = `${JSON.stringify(
    {
      publicKey: key
        .getPublicKey(undefined, 'uncompressed')
        .toString('base64url'),
      privateKey: key.getPrivateKey().toString('base64url'),
    },
    null,
    2,
  )}\n`;
  const directory = resolve(path, '..');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(document, 'utf8');
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  return path;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  generateVapidKeyFile()
    .then((path) =>
      process.stdout.write(
        `VAPID key pair saved with owner-only permissions: ${path}\n`,
      ),
    )
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'Key generation failed'}\n`,
      );
      process.exitCode = 1;
    });
}
