import { randomUUID } from 'node:crypto';

import { sql } from 'kysely';
import { z } from 'zod';

import { createDatabase } from '../server/src/db/kysely';
import { hashPassword } from '../server/src/modules/auth/password';

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith('--') || !value)
    throw new Error(
      'Use --email, --first-name, --last-name and --date-of-birth',
    );
  args.set(key, value);
}
const input = z
  .strictObject({
    email: z.email(),
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    dateOfBirth: z.iso.date(),
  })
  .parse({
    email: args.get('--email'),
    firstName: args.get('--first-name'),
    lastName: args.get('--last-name'),
    dateOfBirth: args.get('--date-of-birth'),
  });
const eighteenthBirthday = new Date(`${input.dateOfBirth}T00:00:00Z`);
eighteenthBirthday.setUTCFullYear(eighteenthBirthday.getUTCFullYear() + 18);
if (eighteenthBirthday > new Date())
  throw new RangeError('Platform staff must be at least 18');

async function hiddenPrompt(label: string): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error('An interactive terminal is required');
  process.stdout.write(label);
  const chars: string[] = [];
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        for (const value of chunk.toString('utf8')) {
          if (value === '\u0003') {
            process.stdin.off('data', onData);
            reject(new Error('Canceled'));
            return;
          }
          if (value === '\r' || value === '\n') {
            process.stdin.off('data', onData);
            process.stdout.write('\n');
            resolve(chars.join(''));
            return;
          }
          if (value === '\u007f' || value === '\b') {
            chars.pop();
          } else if ((value.codePointAt(0) ?? 0) >= 32) {
            chars.push(value);
          }
        }
      };
      process.stdin.on('data', onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}

const password = await hiddenPrompt('Password: ');
const confirmation = await hiddenPrompt('Confirm password: ');
if (password !== confirmation) throw new Error('Passwords do not match');
const passwordHash = await hashPassword(password);
const database = createDatabase(
  process.env.DATABASE_ADMIN_URL ??
    'postgres://athlentry_admin@127.0.0.1:5432/athlentry_dev',
);
try {
  const accountId = randomUUID();
  await database.transaction().execute(async (trx) => {
    const existing = await sql<{
      id: string;
    }>`SELECT id FROM accounts WHERE email = ${input.email}`.execute(trx);
    if (existing.rows[0])
      throw new Error('An account with that email already exists');
    await sql`INSERT INTO accounts
      (id, email, email_verified_at, password_hash, first_name, last_name, date_of_birth)
      VALUES (${accountId}, ${input.email}, now(), ${passwordHash},
        ${input.firstName}, ${input.lastName}, ${input.dateOfBirth})`.execute(
      trx,
    );
    await sql`INSERT INTO platform_staff(account_id, role, active)
      VALUES (${accountId}, 'super_admin', true)`.execute(trx);
    await sql`INSERT INTO platform_audit_log
      (id, staff_account_id, action, target_account_id)
      VALUES (${randomUUID()}, ${accountId}, 'platform_staff.bootstrap', ${accountId})`.execute(
      trx,
    );
  });
  process.stdout.write(
    'Platform admin created. Enroll MFA before platform access.\n',
  );
} finally {
  await database.destroy();
}
