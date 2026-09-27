export type AuditTier = 'public' | 'internal' | 'sensitive' | 'restricted';
export type AuditFieldChange = {
  tier: AuditTier;
  before?: unknown;
  after?: unknown;
};
export type AuditChanges = Record<string, AuditFieldChange>;

const redacted = '[redacted]';

export function redactAuditChanges(
  changes: AuditChanges,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [field, change] of Object.entries(changes)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(field))
      throw new RangeError('Invalid audit field name');
    const restricted = change.tier === 'restricted';
    result[field] = {
      tier: change.tier,
      ...(change.before === undefined
        ? {}
        : { before: restricted ? redacted : change.before }),
      ...(change.after === undefined
        ? {}
        : { after: restricted ? redacted : change.after }),
    };
  }
  return result;
}

export function redactStoredChanges(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [field, change] of Object.entries(value)) {
    if (
      !change ||
      typeof change !== 'object' ||
      Array.isArray(change) ||
      !('tier' in change)
    ) {
      result[field] = redacted;
      continue;
    }
    const item = change as AuditFieldChange;
    if (
      !['public', 'internal', 'sensitive', 'restricted'].includes(item.tier)
    ) {
      result[field] = redacted;
      continue;
    }
    result[field] = redactAuditChanges({ [field]: item })[field];
  }
  return result;
}
