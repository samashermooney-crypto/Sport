import { requireEntity } from "./domain.mjs";
import { getRules } from "./program-rules.mjs";
import { evaluateTeamCompletion } from "./team-completion.mjs";
export function teamRegistrationState(db, org, teamId) {
  const team = requireEntity(db, "teams", teamId, org);
  const program = requireEntity(db, "programs", team.program_id, org);
  const rules = getRules(db, org, program);
  const rows = db
    .prepare(
      `SELECT r.status,p.gender FROM registrations r JOIN people p ON p.id=r.person_id AND p.org_id=r.org_id WHERE r.org_id=? AND r.team_id=? AND r.role IN ('Free Agent','Team Player') AND r.status IN ('Confirmed','Pending') AND json_extract(p.data,'$.archived_at') IS NULL`,
    )
    .all(org, teamId)
    .filter((r) => r.status === "Confirmed" || rules.capacity_includes_pending);
  const invoices = db
    .prepare(
      `SELECT DISTINCT i.id,i.total_cents,i.paid_cents FROM invoices i JOIN registrations r ON r.invoice_id=i.id AND r.org_id=i.org_id WHERE r.org_id=? AND r.team_id=? AND r.status!='Canceled' AND i.voided=0`,
    )
    .all(org, teamId);
  return evaluateTeamCompletion(rules.team_completion, {
    players: rows.length,
    male: rows.filter((p) => p.gender === "Male").length,
    female: rows.filter((p) => p.gender === "Female").length,
    total_cents: invoices.reduce((sum, i) => sum + i.total_cents, 0),
    paid_cents: invoices.reduce((sum, i) => sum + i.paid_cents, 0),
  });
}
