import { z } from "zod";
import { id, now, audit, transaction } from "./db.mjs";
import { DomainError } from "./domain.mjs";
import { parseTryoutConfig } from "./tryout-config.mjs";

function serialize(row) {
  return { id: row.id, ...JSON.parse(row.config), version: row.version, created_at: row.created_at, updated_at: row.updated_at };
}

export function getTryout(db, actor, tryoutId) {
  const row = db.prepare("SELECT * FROM tryouts WHERE id=? AND org_id=?").get(tryoutId, actor.org_id);
  if (!row) throw new DomainError("Tryout not found.", 404);
  return serialize(row);
}

export function listTryouts(db, actor) {
  return db.prepare("SELECT * FROM tryouts WHERE org_id=? ORDER BY created_at DESC,id").all(actor.org_id).map(serialize);
}

export function createTryout(db, actor, input) {
  const requestKey = z.object({ request_key: z.uuid() }).parse(input).request_key;
  const config = parseTryoutConfig(input);
  const encoded = JSON.stringify(config);
  return transaction(db, () => {
    const prior = db.prepare("SELECT * FROM tryouts WHERE org_id=? AND request_key=?").get(actor.org_id, requestKey);
    if (prior) {
      if (prior.request_config !== encoded) throw new DomainError("This request was already used with different tryout details.", 409);
      return serialize(prior);
    }
    const program = db.prepare("SELECT id,grouped FROM programs WHERE id=? AND org_id=? AND archived_at IS NULL").get(config.program_id, actor.org_id);
    if (!program || program.grouped) throw new DomainError("Choose an available registration program or subprogram.");
    for (const round of config.rounds) {
      if (round.location_id && !db.prepare("SELECT id FROM locations WHERE id=? AND org_id=? AND json_extract(data,'$.archived_at') IS NULL").get(round.location_id, actor.org_id))
        throw new DomainError("A selected location is unavailable.");
    }
    const tryoutId = id(), timestamp = now();
    db.prepare("INSERT INTO tryouts(id,org_id,program_id,name,config,request_key,request_config,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(tryoutId, actor.org_id, config.program_id, config.name, encoded, requestKey, encoded, timestamp, timestamp);
    audit(db, actor, "create", "tryout", tryoutId, { program_id: config.program_id, rounds: config.rounds.length });
    return getTryout(db, actor, tryoutId);
  });
}

export function installTryoutRoutes(app, db) {
  app.get("/api/tryouts", (req, res) => res.json(listTryouts(db, req.actor)));
  app.get("/api/tryouts/:id", (req, res) => res.json(getTryout(db, req.actor, req.params.id)));
  app.post("/api/tryouts", (req, res) => res.json(createTryout(db, req.actor, req.body)));
}
