export type ConversationMember = {
  accountId: string;
  age: number;
  adultRole: 'staff' | 'coach' | 'volunteer' | 'official' | null;
  guardianOf: readonly string[];
};
export type SafeSportInput = {
  kind: 'message' | 'direct' | 'team';
  senderAccountId: string;
  members: readonly ConversationMember[];
  guardianLinks: Readonly<Record<string, readonly string[]>>;
  smsRecipientIds?: readonly string[];
};
export type SafeSportResult = {
  allowed: boolean;
  code: 'SAFESPORT_GUARDIAN_REQUIRED' | null;
  guardianAdditions: string[];
  guardianCopied: boolean;
  blockedSmsRecipientIds: string[];
};

export function checkSafeSport(input: SafeSportInput): SafeSportResult {
  const byId = new Map(
    input.members.map((member) => [member.accountId, member]),
  );
  if (byId.size !== input.members.length)
    throw new RangeError('Duplicate conversation member');
  const sender = byId.get(input.senderAccountId);
  if (!sender) throw new RangeError('Sender must be a member');
  const minorIds = input.members
    .filter((member) => member.age < 18)
    .map((member) => member.accountId);
  const blockedSmsRecipientIds = (input.smsRecipientIds ?? []).filter((id) =>
    minorIds.includes(id),
  );
  const additions = new Set<string>();
  let guardianCopied = false;
  for (const minorId of minorIds) {
    const guardians = input.guardianLinks[minorId] ?? [];
    const adultNonGuardianPresent = input.members.some(
      (member) =>
        member.age >= 18 &&
        member.adultRole !== null &&
        !member.guardianOf.includes(minorId),
    );
    if (!adultNonGuardianPresent && input.kind !== 'team') continue;
    if (guardians.length === 0)
      return {
        allowed: false,
        code: 'SAFESPORT_GUARDIAN_REQUIRED',
        guardianAdditions: [],
        guardianCopied: false,
        blockedSmsRecipientIds,
      };
    const guardianPresent = guardians.some((id) => byId.has(id));
    if (input.kind === 'direct' && !guardianPresent)
      return {
        allowed: false,
        code: 'SAFESPORT_GUARDIAN_REQUIRED',
        guardianAdditions: [],
        guardianCopied: false,
        blockedSmsRecipientIds,
      };
    if (input.kind === 'team')
      guardians.forEach((id) => {
        if (!byId.has(id)) additions.add(id);
      });
    else if (!guardianPresent)
      guardians.forEach((id) => {
        additions.add(id);
      });
    guardianCopied = true;
  }
  return {
    allowed: true,
    code: null,
    guardianAdditions: [...additions].sort(),
    guardianCopied,
    blockedSmsRecipientIds,
  };
}
