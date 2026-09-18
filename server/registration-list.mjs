export function listRegistrations(db, orgId, programId) {
  const origins = new Map(db.prepare(`SELECT a.entity_id,json_extract(a.details,'$.role') role FROM audit_log a
    JOIN registrations r ON r.id=a.entity_id AND r.org_id=a.org_id
    WHERE a.org_id=? AND a.entity_type='registration' AND a.action='register'
      AND (? IS NULL OR r.program_id=?) ORDER BY a.created_at DESC`)
    .all(orgId, programId || null, programId || null).map(row => [row.entity_id, row.role]));
  return db.prepare(`SELECT r.*,p.first_name,p.last_name,p.gender,p.birthdate,p.email,
    t.name team_name,i.id active_invoice_id,i.number invoice_number,i.total_cents,i.paid_cents
    FROM registrations r JOIN people p ON p.id=r.person_id AND p.org_id=r.org_id
    LEFT JOIN teams t ON t.id=r.team_id AND t.org_id=r.org_id
    LEFT JOIN invoices i ON i.id=r.invoice_id AND i.org_id=r.org_id AND i.voided=0
    WHERE r.org_id=? AND (? IS NULL OR r.program_id=?) ORDER BY r.created_at DESC`)
    .all(orgId, programId || null, programId || null)
    .map(({active_invoice_id, ...row}) => ({...row, invoice_id: active_invoice_id, original_role: origins.get(row.id) || null}));
}
