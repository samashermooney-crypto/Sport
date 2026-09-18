import { migrateRegistrationHistory } from "./registration-migration.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  randomUUID,
  scryptSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function passwordMatches(password, hash) {
  const [salt, key] = hash.split(":");
  const candidate = scryptSync(password, salt, 64);
  return timingSafeEqual(candidate, Buffer.from(key, "hex"));
}
export function openDb(path = "data/fieldhouse.sqlite") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,timezone TEXT NOT NULL DEFAULT 'America/Chicago',currency TEXT NOT NULL DEFAULT 'USD');
    CREATE TABLE IF NOT EXISTS schedule_imports(org_id TEXT NOT NULL REFERENCES organizations(id),request_key TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(org_id,request_key));
    CREATE TABLE IF NOT EXISTS registration_transfers(org_id TEXT NOT NULL REFERENCES organizations(id),request_key TEXT NOT NULL,request_hash TEXT NOT NULL,result TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(org_id,request_key));
    CREATE TABLE IF NOT EXISTS tryouts(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),program_id TEXT NOT NULL REFERENCES programs(id),name TEXT NOT NULL,config TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,request_key TEXT NOT NULL,request_config TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(org_id,request_key));
    CREATE INDEX IF NOT EXISTS tryouts_org_program ON tryouts(org_id,program_id);
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),name TEXT NOT NULL,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','admin','manager','coach','parent','reporter')),active INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 1,deactivated_at TEXT);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_invitations(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),email TEXT NOT NULL COLLATE NOCASE,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','admin','manager','reporter')),token_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Accepted','Revoked')),sent_at TEXT,delivery_error TEXT NOT NULL DEFAULT '',expires_at TEXT NOT NULL,invited_by TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS admin_invitations_one_pending ON admin_invitations(org_id,email) WHERE status='Pending';
    CREATE INDEX IF NOT EXISTS admin_invitations_org ON admin_invitations(org_id,created_at);
    CREATE TABLE IF NOT EXISTS admin_reset_tokens(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS member_account_invitations(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),person_id TEXT NOT NULL REFERENCES people(id),email TEXT NOT NULL COLLATE NOCASE,person_email TEXT NOT NULL DEFAULT '',token_hash TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending','Accepted','Revoked')),sent_at TEXT,delivery_error TEXT NOT NULL DEFAULT '',expires_at TEXT NOT NULL,invited_by TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS member_invitations_one_pending ON member_account_invitations(org_id,person_id) WHERE status='Pending';
    CREATE INDEX IF NOT EXISTS member_invitations_org ON member_account_invitations(org_id,created_at);
    CREATE TABLE IF NOT EXISTS households(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),household_id TEXT REFERENCES households(id),first_name TEXT NOT NULL,last_name TEXT NOT NULL,email TEXT NOT NULL DEFAULT '',birthdate TEXT NOT NULL DEFAULT '',gender TEXT NOT NULL DEFAULT 'Unknown',kind TEXT NOT NULL DEFAULT 'player',data TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS locations(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),parent_id TEXT REFERENCES locations(id),name TEXT NOT NULL,address TEXT NOT NULL DEFAULT '',data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS programs(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),parent_id TEXT REFERENCES programs(id),name TEXT NOT NULL,type TEXT NOT NULL,sport TEXT NOT NULL,gender TEXT NOT NULL,level TEXT NOT NULL,season TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Unpublished',grouped INTEGER NOT NULL DEFAULT 0,start_date TEXT NOT NULL,end_date TEXT NOT NULL DEFAULT '',registration_start TEXT NOT NULL DEFAULT '',registration_end TEXT NOT NULL DEFAULT '',fee_cents INTEGER NOT NULL DEFAULT 0 CHECK(fee_cents>=0),capacity INTEGER CHECK(capacity IS NULL OR capacity>0),waitlist INTEGER NOT NULL DEFAULT 1,public INTEGER NOT NULL DEFAULT 1,data TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived_at TEXT);
    CREATE TABLE IF NOT EXISTS teams(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),program_id TEXT NOT NULL REFERENCES programs(id),name TEXT NOT NULL,division TEXT NOT NULL DEFAULT '',locked INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,UNIQUE(program_id,name));
    CREATE TABLE IF NOT EXISTS invoices(id TEXT PRIMARY KEY,number INTEGER NOT NULL UNIQUE,org_id TEXT NOT NULL REFERENCES organizations(id),program_id TEXT REFERENCES programs(id),person_id TEXT NOT NULL REFERENCES people(id),description TEXT NOT NULL,total_cents INTEGER NOT NULL CHECK(total_cents>=0),paid_cents INTEGER NOT NULL DEFAULT 0 CHECK(paid_cents>=0 AND paid_cents<=total_cents),due_date TEXT NOT NULL DEFAULT '',voided INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invoice_payment_plans(invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,org_id TEXT NOT NULL REFERENCES organizations(id),snapshot TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS registrations(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),program_id TEXT NOT NULL REFERENCES programs(id),person_id TEXT NOT NULL REFERENCES people(id),team_id TEXT REFERENCES teams(id),invoice_id TEXT REFERENCES invoices(id),role TEXT NOT NULL DEFAULT 'Free Agent',status TEXT NOT NULL CHECK(status IN ('Confirmed','Pending','Wait List','Canceled')),waiver_accepted_at TEXT,created_at TEXT NOT NULL,UNIQUE(program_id,person_id));
    CREATE TABLE IF NOT EXISTS transactions(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),invoice_id TEXT NOT NULL REFERENCES invoices(id),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),type TEXT NOT NULL CHECK(type IN ('payment','refund')),method TEXT NOT NULL,reference TEXT NOT NULL DEFAULT '',idempotency_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),program_id TEXT NOT NULL REFERENCES programs(id),home_team_id TEXT REFERENCES teams(id),away_team_id TEXT REFERENCES teams(id),location_id TEXT REFERENCES locations(id),type TEXT NOT NULL,title TEXT NOT NULL,start_at TEXT NOT NULL,end_at TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'Scheduled',home_score INTEGER,away_score INTEGER,published INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS settings(org_id TEXT NOT NULL REFERENCES organizations(id),scope TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(org_id,scope,key));
    CREATE TABLE IF NOT EXISTS audit_log(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),user_id TEXT,action TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,details TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS program_org ON programs(org_id,archived_at,status);
    CREATE INDEX IF NOT EXISTS registrations_program ON registrations(org_id,program_id,status);
    CREATE TABLE IF NOT EXISTS installment_payment_allocations(transaction_id TEXT PRIMARY KEY REFERENCES transactions(id),org_id TEXT NOT NULL REFERENCES organizations(id),invoice_id TEXT NOT NULL REFERENCES invoices(id),selected_position INTEGER,allocations TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS invoice_org ON invoices(org_id,due_date);
    CREATE INDEX IF NOT EXISTS event_org ON events(org_id,start_at,end_at);
    CREATE TABLE IF NOT EXISTS household_details(household_id TEXT PRIMARY KEY REFERENCES households(id),type TEXT NOT NULL DEFAULT 'Family',description TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS household_members(household_id TEXT NOT NULL REFERENCES households(id),person_id TEXT NOT NULL REFERENCES people(id),role TEXT NOT NULL CHECK(role IN ('Supervisor','Member')),PRIMARY KEY(household_id,person_id));
    CREATE TABLE IF NOT EXISTS discounts(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),program_id TEXT REFERENCES programs(id),name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',code TEXT NOT NULL COLLATE NOCASE,kind TEXT NOT NULL CHECK(kind IN ('Fixed','Percentage')),value INTEGER NOT NULL CHECK(value>0),expires TEXT NOT NULL DEFAULT '',redemption_limit INTEGER,multi_use INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,UNIQUE(org_id,code));
    CREATE TABLE IF NOT EXISTS discount_redemptions(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),discount_id TEXT NOT NULL REFERENCES discounts(id),person_id TEXT NOT NULL REFERENCES people(id),invoice_id TEXT NOT NULL REFERENCES invoices(id),amount_cents INTEGER NOT NULL CHECK(amount_cents>=0),created_at TEXT NOT NULL,UNIQUE(discount_id,invoice_id));
    CREATE TABLE IF NOT EXISTS credits(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),person_id TEXT NOT NULL REFERENCES people(id),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),description TEXT NOT NULL DEFAULT '',expires TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS credit_applications(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),credit_id TEXT NOT NULL REFERENCES credits(id),invoice_id TEXT NOT NULL REFERENCES invoices(id),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),idempotency_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
    INSERT OR IGNORE INTO household_members SELECT household_id,id,CASE WHEN kind='parent' THEN 'Supervisor' ELSE 'Member' END FROM people WHERE household_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS email_contacts(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),email TEXT NOT NULL COLLATE NOCASE,status TEXT NOT NULL DEFAULT 'Subscribed',created_at TEXT NOT NULL,UNIQUE(org_id,email));
    CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),author_id TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,channel TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'Draft',data TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,queued_at TEXT);
    CREATE TABLE IF NOT EXISTS message_recipients(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),message_id TEXT NOT NULL REFERENCES messages(id),person_id TEXT REFERENCES people(id),channel TEXT NOT NULL,address TEXT NOT NULL,name TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'Queued',provider_id TEXT,error TEXT NOT NULL DEFAULT '',attempted_at TEXT,completed_at TEXT,UNIQUE(message_id,channel,address));
    CREATE TABLE IF NOT EXISTS message_templates(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),name TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS message_org ON messages(org_id,created_at);
    CREATE INDEX IF NOT EXISTS recipient_queue ON message_recipients(status,message_id);
    CREATE TABLE IF NOT EXISTS team_staff(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),team_id TEXT NOT NULL REFERENCES teams(id),person_id TEXT NOT NULL REFERENCES people(id),role TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(team_id,person_id));
    CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),mime TEXT NOT NULL,bytes BLOB NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),name TEXT NOT NULL,sku TEXT NOT NULL DEFAULT '',price_cents INTEGER NOT NULL CHECK(price_cents>=0),inventory INTEGER CHECK(inventory IS NULL OR inventory>=0),published INTEGER NOT NULL DEFAULT 1,availability TEXT NOT NULL DEFAULT 'Private',data TEXT NOT NULL DEFAULT '{}',version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,archived_at TEXT);
    CREATE TABLE IF NOT EXISTS product_programs(product_id TEXT NOT NULL REFERENCES products(id),program_id TEXT NOT NULL REFERENCES programs(id),PRIMARY KEY(product_id,program_id));
    CREATE TABLE IF NOT EXISTS product_variants(id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id),name TEXT NOT NULL,sku TEXT NOT NULL DEFAULT '',price_cents INTEGER NOT NULL CHECK(price_cents>=0),inventory INTEGER CHECK(inventory IS NULL OR inventory>=0),active INTEGER NOT NULL DEFAULT 1,UNIQUE(product_id,name));
    CREATE TABLE IF NOT EXISTS store_categories(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',position INTEGER NOT NULL DEFAULT 0,UNIQUE(org_id,name));
    CREATE TABLE IF NOT EXISTS category_products(category_id TEXT NOT NULL REFERENCES store_categories(id),product_id TEXT NOT NULL REFERENCES products(id),position INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(category_id,product_id));
    CREATE TABLE IF NOT EXISTS product_orders(id TEXT PRIMARY KEY,number INTEGER NOT NULL UNIQUE,org_id TEXT NOT NULL REFERENCES organizations(id),product_id TEXT NOT NULL REFERENCES products(id),variant_id TEXT REFERENCES product_variants(id),person_id TEXT NOT NULL REFERENCES people(id),purchaser_id TEXT NOT NULL REFERENCES people(id),program_id TEXT REFERENCES programs(id),invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id),quantity INTEGER NOT NULL CHECK(quantity>0),status TEXT NOT NULL DEFAULT 'Open' CHECK(status IN ('Open','Closed','Canceled')),shipped_at TEXT,closed_at TEXT,expires_at TEXT,data TEXT NOT NULL,request_hash TEXT NOT NULL,idempotency_key TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(org_id,idempotency_key));
    CREATE INDEX IF NOT EXISTS products_org ON products(org_id,archived_at);
    CREATE INDEX IF NOT EXISTS orders_org ON product_orders(org_id,created_at);
    CREATE TABLE IF NOT EXISTS website_settings(org_id TEXT PRIMARY KEY REFERENCES organizations(id),version INTEGER NOT NULL DEFAULT 1,data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS website_pages(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),name TEXT NOT NULL,title TEXT NOT NULL,slug TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'custom',external_url TEXT NOT NULL DEFAULT '',published INTEGER NOT NULL DEFAULT 0,requires_login INTEGER NOT NULL DEFAULT 0,menu_enabled INTEGER NOT NULL DEFAULT 0,menu_label TEXT NOT NULL DEFAULT '',menu_parent_id TEXT REFERENCES website_pages(id),menu_order INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL DEFAULT '{}',version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(org_id,slug));
    CREATE TABLE IF NOT EXISTS website_revisions(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),page_id TEXT NOT NULL REFERENCES website_pages(id) ON DELETE CASCADE,version INTEGER NOT NULL,snapshot TEXT NOT NULL,user_id TEXT,created_at TEXT NOT NULL,UNIQUE(page_id,version));
    CREATE INDEX IF NOT EXISTS website_org ON website_pages(org_id,published);
    CREATE TABLE IF NOT EXISTS form_definitions(org_id TEXT NOT NULL REFERENCES organizations(id),scope TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,data TEXT NOT NULL,PRIMARY KEY(org_id,scope));
    CREATE TABLE IF NOT EXISTS activity_attendance(org_id TEXT NOT NULL REFERENCES organizations(id),event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,person_id TEXT NOT NULL REFERENCES people(id),rsvp TEXT NOT NULL DEFAULT '' CHECK(rsvp IN ('','Yes','No','Maybe')),checked_in_at TEXT,version INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(event_id,person_id));
    CREATE TABLE IF NOT EXISTS attendance_roster_snapshots(event_id TEXT NOT NULL,person_id TEXT NOT NULL,org_id TEXT NOT NULL REFERENCES organizations(id),first_name TEXT NOT NULL,last_name TEXT NOT NULL,team_id TEXT,team_name TEXT,captured_at TEXT NOT NULL,PRIMARY KEY(event_id,person_id),FOREIGN KEY(event_id,person_id) REFERENCES activity_attendance(event_id,person_id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS registration_answers(registration_id TEXT PRIMARY KEY REFERENCES registrations(id),org_id TEXT NOT NULL REFERENCES organizations(id),definition_version INTEGER NOT NULL,definition TEXT NOT NULL,answers TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_answers(person_id TEXT PRIMARY KEY REFERENCES people(id),org_id TEXT NOT NULL REFERENCES organizations(id),definition_version INTEGER NOT NULL,definition TEXT NOT NULL,answers TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS profile_answer_revisions(id TEXT PRIMARY KEY,person_id TEXT NOT NULL REFERENCES people(id),org_id TEXT NOT NULL REFERENCES organizations(id),version INTEGER NOT NULL,definition TEXT NOT NULL,answers TEXT NOT NULL,recorded_by TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(person_id,version));
    CREATE TABLE IF NOT EXISTS form_files(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),name TEXT NOT NULL,mime TEXT NOT NULL,bytes BLOB NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS waiver_acceptances(id TEXT PRIMARY KEY,org_id TEXT NOT NULL REFERENCES organizations(id),registration_id TEXT NOT NULL REFERENCES registrations(id),person_id TEXT NOT NULL REFERENCES people(id),signer_id TEXT NOT NULL REFERENCES people(id),waiver_id TEXT NOT NULL,waiver_version INTEGER NOT NULL,document TEXT NOT NULL,method TEXT NOT NULL,recorded_by TEXT NOT NULL,accepted_at TEXT NOT NULL,recorded_at TEXT NOT NULL,UNIQUE(registration_id,waiver_id));
  `);
  db.exec(`CREATE TABLE IF NOT EXISTS member_checkouts(
    org_id TEXT NOT NULL REFERENCES organizations(id), account_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, receipt TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY(org_id,account_id,idempotency_key)
  )`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS primary_staff_person_archived
    AFTER UPDATE OF data ON people
    WHEN json_extract(NEW.data,'$.archived_at') IS NOT NULL
    BEGIN
      UPDATE teams SET data=json_remove(data,'$.primary_staff_person_id')
      WHERE org_id=NEW.org_id AND json_extract(data,'$.primary_staff_person_id')=NEW.id;
    END`);
  // Keep the designation attached only while an eligible assignment exists.
  // Both assignment representations must agree, including direct SQL migrations.
  for (const table of ["registrations", "team_staff"]) {
    for (const event of ["UPDATE", "DELETE"]) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS primary_staff_${table}_${event.toLowerCase()}
        AFTER ${event} ON ${table}
        BEGIN
          UPDATE teams SET data=json_remove(data,'$.primary_staff_person_id')
          WHERE id=OLD.team_id AND org_id=OLD.org_id
            AND json_extract(data,'$.primary_staff_person_id')=OLD.person_id
            AND NOT EXISTS (SELECT 1 FROM team_staff s WHERE s.team_id=teams.id AND s.org_id=teams.org_id
              AND s.person_id=OLD.person_id AND s.role NOT IN ('Free Agent','Team Player','Team',''))
            AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.team_id=teams.id AND r.org_id=teams.org_id
              AND r.person_id=OLD.person_id AND r.status='Confirmed' AND r.role NOT IN ('Free Agent','Team Player','Team',''));
        END`);
    }
  }
  migrateRegistrationHistory(db);
  migrateConsoleAccess(db);
  return db;
}
// Add console-access lifecycle columns to databases created before them.
function migrateConsoleAccess(db) {
  const columns = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  for (const [name, definition] of [
    ["active", "active INTEGER NOT NULL DEFAULT 1"],
    ["revision", "revision INTEGER NOT NULL DEFAULT 1"],
    ["deactivated_at", "deactivated_at TEXT"],
  ])
    if (!columns.includes(name))
      db.exec(`ALTER TABLE users ADD COLUMN ${definition}`);
}
const transactionDepth = new WeakMap();
export function transaction(db, fn) {
  const depth = transactionDepth.get(db) || 0;
  const savepoint = `fieldhouse_nested_${depth}`;
  db.exec(depth ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
  transactionDepth.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(depth ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
    return result;
  } catch (error) {
    if (depth) {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } else db.exec("ROLLBACK");
    throw error;
  } finally {
    if (depth) transactionDepth.set(db, depth);
    else transactionDepth.delete(db);
  }
}
export function audit(db, actor, action, entityType, entityId, details = {}) {
  db.prepare("INSERT INTO audit_log VALUES(?,?,?,?,?,?,?,?)").run(
    id(),
    actor.org_id,
    actor.id ?? null,
    action,
    entityType,
    entityId,
    JSON.stringify(details),
    now(),
  );
}
export function unpack(row) {
  if (!row) return null;
  const { data, ...rest } = row;
  return { ...rest, ...(data ? JSON.parse(data) : {}) };
}
