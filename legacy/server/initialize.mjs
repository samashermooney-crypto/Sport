import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { openDb, id, passwordHash, transaction, audit } from "./db.mjs";

export function organizationId(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "organization";
}

export const initializationSchema = z.object({
  orgName: z.string().trim().min(1).max(150),
  orgId: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Use lowercase letters, numbers and single dashes",
    ),
  timezone: z
    .string()
    .max(100)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, "Choose a valid IANA time zone such as America/Chicago"),
  ownerName: z.string().trim().min(1).max(100),
  ownerEmail: z
    .email()
    .max(254)
    .transform((v) => v.trim().toLowerCase()),
  ownerPassword: z
    .string()
    .min(12, "Use at least 12 characters for the owner password.")
    .max(128),
});

// Creates the first real organization and its owner. Refuses to run on an
// occupied database so production data is never reinitialized silently.
export function initializeOrganization(db, input) {
  const p = initializationSchema.parse(input);
  return transaction(db, () => {
    if (
      db.prepare("SELECT 1 FROM organizations LIMIT 1").get() ||
      db.prepare("SELECT 1 FROM users LIMIT 1").get()
    )
      throw Object.assign(
        new Error(
          "This database already contains an organization or console users. Initialization is refused.",
        ),
        { code: "OCCUPIED" },
      );
    db.prepare("INSERT INTO organizations VALUES(?,?,?,?)").run(
      p.orgId,
      p.orgName,
      p.timezone,
      "USD",
    );
    const ownerId = id();
    db.prepare(
      "INSERT INTO users(id,org_id,name,email,password_hash,role) VALUES(?,?,?,?,?,?)",
    ).run(
      ownerId,
      p.orgId,
      p.ownerName,
      p.ownerEmail,
      passwordHash(p.ownerPassword),
      "owner",
    );
    audit(
      db,
      { id: null, org_id: p.orgId },
      "organization.initialized",
      "organization",
      p.orgId,
      { name: p.orgName, timezone: p.timezone, owner_email: p.ownerEmail },
    );
    return { orgId: p.orgId, ownerId, ownerEmail: p.ownerEmail };
  });
}

function hiddenPrompt(query) {
  return new Promise((resolvePromise) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl.stdoutMuted = true;
    rl._writeToOutput = (s) => {
      if (rl.stdoutMuted) rl.output.write("");
      else rl.output.write(s);
    };
    process.stdout.write(query);
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolvePromise(answer);
    });
  });
}

async function ask(rl, query, fallback) {
  if (fallback) return fallback;
  const answer = await new Promise((r) => rl.question(query, r));
  return answer.trim();
}

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      flags[key] = inline !== undefined ? inline : argv[++i];
    }
  }
  return flags;
}

const usage = `Usage: npm run init -- [options]
  --db PATH            Database file (default: DATABASE_PATH or data/fieldhouse.sqlite)
  --org-name NAME      Organization name
  --org-id ID          Organization id used in member site URLs (default: derived from name)
  --timezone TZ        IANA time zone (default: prompt; example America/Chicago)
  --owner-name NAME    Initial owner display name
  --owner-email EMAIL  Initial owner sign-in email

The owner password is read from a hidden prompt, or set FIELDHOUSE_OWNER_PASSWORD
for non-interactive use. Passwords are never printed or logged.`;

export async function main(argv, env = process.env) {
  const flags = parseArgs(argv);
  if (flags.help) return console.log(usage);
  const path = flags.db || env.DATABASE_PATH || "data/fieldhouse.sqlite";
  const tty = process.stdin.isTTY;
  let rl = null;
  const need = (name) =>
    flags[name] === undefined && !tty
      ? missing.push(`--${name}`)
      : flags[name];
  const missing = [];
  const given = {
    orgName: need("org-name"),
    timezone: need("timezone"),
    ownerName: need("owner-name"),
    ownerEmail: need("owner-email"),
  };
  if (!env.FIELDHOUSE_OWNER_PASSWORD && !tty) missing.push("password input");
  if (missing.length)
    throw Object.assign(
      new Error(`Missing required values: ${missing.join(", ")}`),
      { code: "USAGE" },
    );
  if (tty) rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const orgName = await ask(rl, "Organization name: ", given.orgName);
    const timezone =
      (await ask(rl, "Time zone (e.g. America/Chicago): ", given.timezone)) ||
      "America/Chicago";
    const ownerName = await ask(rl, "Owner name: ", given.ownerName);
    const ownerEmail = await ask(rl, "Owner email: ", given.ownerEmail);
    const orgId = flags["org-id"] || organizationId(orgName);
    let ownerPassword = env.FIELDHOUSE_OWNER_PASSWORD;
    if (!ownerPassword) {
      if (rl) rl.close();
      const first = await hiddenPrompt("Owner password (hidden): ");
      const second = await hiddenPrompt("Confirm owner password: ");
      if (first !== second)
        throw Object.assign(new Error("Passwords did not match."), {
          code: "USAGE",
        });
      ownerPassword = first;
    }
    const db = openDb(path);
    try {
      const result = initializeOrganization(db, {
        orgName,
        orgId,
        timezone,
        ownerName,
        ownerEmail,
        ownerPassword,
      });
      console.log(`Initialized organization "${orgName}" (${result.orgId}).`);
      console.log(
        `Owner ${result.ownerEmail} can sign in after starting the server.`,
      );
      console.log(`Database: ${resolve(path)}`);
    } finally {
      db.close();
    }
  } finally {
    if (rl) rl.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    if (error instanceof z.ZodError)
      console.error(error.issues.map((i) => i.message).join("\n"));
    else console.error(error.message);
    process.exitCode = error.code === "OCCUPIED" ? 2 : 1;
  });
}
