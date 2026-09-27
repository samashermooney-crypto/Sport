import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPost } from '../../api/client';
import { Button, Card, DataTable, Field, Input, PageHeader } from '../../ui';
import type { Column } from '../../ui';

import './team-finance-portal.css';

const uuid = z.uuid();
const ledgersSchema = z.strictObject({
  ledgers: z.array(
    z.strictObject({
      teamSeasonId: uuid,
      teamName: z.string(),
      programName: z.string(),
      status: z.string(),
      budgetCents: z.number().int().nonnegative(),
      incomeCents: z.number().int().nonnegative(),
      expenseCents: z.number().int().nonnegative(),
      balanceCents: z.number().int(),
      openReimbursements: z.number().int().nonnegative(),
      overdueObligations: z.number().int().nonnegative(),
      requesterPersonId: uuid.nullable().optional(),
    }),
  ),
});
const ledgerSchema = z.strictObject({
  teamSeasonId: uuid,
  budgetCents: z.number().int().nonnegative(),
  incomeCents: z.number().int().nonnegative(),
  expenseCents: z.number().int().nonnegative(),
  balanceCents: z.number().int(),
  entries: z.array(
    z.strictObject({
      id: uuid,
      direction: z.enum(['income', 'expense']),
      category: z.string(),
      amountCents: z.number().int().positive(),
      occurredOn: z.iso.date(),
      memo: z.string().nullable(),
      source: z.enum(['team_fee_payment', 'manual', 'reimbursement']),
      createdAt: z.iso.datetime(),
    }),
  ),
});
const reimbursementSchema = z.strictObject({
  id: uuid,
  teamSeasonId: uuid,
  requesterAccountId: uuid,
  requesterPersonId: uuid,
  amountCents: z.number().int().positive(),
  category: z.string(),
  memo: z.string(),
  receiptFileId: uuid,
  status: z.enum(['submitted', 'approved', 'rejected', 'paid']),
  decisionReason: z.string().nullable(),
  version: z.number().int().positive(),
});
const reimbursementsSchema = z.strictObject({
  requests: z.array(reimbursementSchema),
});
const uploadSchema = z.strictObject({
  fileId: uuid,
  uploadUrl: z.string().min(1),
});
const completeUploadSchema = z.strictObject({ id: uuid });

type TeamLedger = z.output<typeof ledgersSchema>['ledgers'][number];
type LedgerEntry = z.output<typeof ledgerSchema>['entries'][number];
type Reimbursement = z.output<typeof reimbursementSchema>;

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

export function TeamFinancePortal({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const base = `/team-finance/orgs/${encodeURIComponent(orgId)}`;
  const [teams, setTeams] = useState<TeamLedger[]>([]);
  const [teamId, setTeamId] = useState('');
  const [ledger, setLedger] = useState<z.output<typeof ledgerSchema> | null>(
    null,
  );
  const [requests, setRequests] = useState<Reimbursement[]>([]);
  const [receipt, setReceipt] = useState<File | null>(null);
  const [category, setCategory] = useState('Travel');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const team = teams.find((item) => item.teamSeasonId === teamId);

  const refresh = useCallback(async () => {
    try {
      const result = await apiGet(`${base}/me/ledgers`, ledgersSchema);
      setTeams(result.ledgers);
      setTeamId((current) =>
        result.ledgers.some((item) => item.teamSeasonId === current)
          ? current
          : (result.ledgers[0]?.teamSeasonId ?? ''),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Team finance access is unavailable.',
      );
    }
  }, [base]);

  const refreshTeam = useCallback(async () => {
    if (!teamId) {
      setLedger(null);
      setRequests([]);
      return;
    }
    const teamBase = `${base}/teams/${encodeURIComponent(teamId)}`;
    try {
      const [ledgerResult, requestResult] = await Promise.all([
        apiGet(`${teamBase}/ledger`, ledgerSchema),
        apiGet(`${teamBase}/reimbursements`, reimbursementsSchema),
      ]);
      setLedger(ledgerResult);
      setRequests(requestResult.requests);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Team ledger is unavailable.',
      );
    }
  }, [base, teamId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    void refreshTeam();
  }, [refreshTeam]);

  async function uploadReceipt(
    file: File,
    selectedTeamId: string,
  ): Promise<string> {
    const supported = new Set([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
    if (
      !supported.has(file.type) ||
      file.size <= 0 ||
      file.size > 10 * 1024 * 1024
    )
      throw new Error('Choose a PDF, JPEG or PNG receipt up to 10 MB.');
    const upload = await apiPost(
      '/files/uploads',
      {
        purpose: 'document',
        mime: file.type,
        bytes: file.size,
        ownerType: 'team',
        ownerId: selectedTeamId,
        sensitivity: 'internal',
      },
      uploadSchema,
      undefined,
      { 'X-Athlentry-Org': orgId },
    );
    const local = upload.uploadUrl.startsWith('/');
    const put = await fetch(upload.uploadUrl, {
      method: 'PUT',
      body: file,
      credentials: local ? 'include' : 'omit',
      headers: {
        'Content-Type': file.type,
        ...(local
          ? { 'X-Athlentry-Request': '1', 'X-Athlentry-Org': orgId }
          : {}),
      },
    });
    if (!put.ok) throw new Error('Receipt upload failed.');
    await apiPost(
      `/files/uploads/${encodeURIComponent(upload.fileId)}/complete`,
      {},
      completeUploadSchema,
      undefined,
      { 'X-Athlentry-Org': orgId },
    );
    return upload.fileId;
  }

  async function submitReimbursement(
    event: React.SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!team?.requesterPersonId || !receipt || !teamId) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const receiptFileId = await uploadReceipt(receipt, teamId);
      await apiPost(
        `${base}/reimbursements`,
        {
          teamSeasonId: teamId,
          requesterPersonId: team.requesterPersonId,
          amountCents: Math.round(Number(amount) * 100),
          category,
          memo,
          receiptFileId,
        },
        reimbursementSchema,
      );
      setAmount('');
      setMemo('');
      setReceipt(null);
      setNotice('Reimbursement submitted for club finance review.');
      await Promise.all([refresh(), refreshTeam()]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Reimbursement could not be submitted.',
      );
    } finally {
      setBusy(false);
    }
  }

  const entryColumns: Column<LedgerEntry>[] = [
    {
      key: 'date',
      label: 'Date',
      render: (row) => row.occurredOn,
      sort: (row) => row.occurredOn,
    },
    {
      key: 'direction',
      label: 'Type',
      render: (row) => (row.direction === 'income' ? 'Income' : 'Expense'),
    },
    { key: 'category', label: 'Category', render: (row) => row.category },
    {
      key: 'amount',
      label: 'Amount',
      render: (row) => money(row.amountCents),
      sort: (row) => row.amountCents,
    },
    { key: 'memo', label: 'Details', render: (row) => row.memo ?? '—' },
  ];

  return (
    <main className="console-home team-finance-portal">
      <PageHeader
        kicker="TEAM TREASURER"
        title="Team finances"
        description="Review team balances and submit receipt-backed reimbursement requests."
      />
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <Card>
        <Field label="Team">
          <select
            className="ui-select"
            aria-label="Team"
            value={teamId}
            onChange={(event) => {
              setTeamId(event.target.value);
            }}
          >
            {teams.map((item) => (
              <option key={item.teamSeasonId} value={item.teamSeasonId}>
                {item.programName} · {item.teamName}
              </option>
            ))}
          </select>
        </Field>
        {ledger ? (
          <p>
            Income {money(ledger.incomeCents)} · Expenses{' '}
            {money(ledger.expenseCents)} · Balance {money(ledger.balanceCents)}
          </p>
        ) : null}
        <DataTable
          rows={ledger?.entries ?? []}
          columns={entryColumns}
          empty="No team ledger entries yet."
        />
      </Card>
      <Card>
        <h2>Submit a reimbursement</h2>
        <form
          className="team-finance-portal__form"
          onSubmit={(event) => {
            void submitReimbursement(event);
          }}
        >
          <Field label="Category">
            <Input
              value={category}
              onChange={(event) => {
                setCategory(event.target.value);
              }}
              maxLength={80}
              required
            />
          </Field>
          <Field label="Amount in dollars">
            <Input
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
              required
            />
          </Field>
          <Field
            label="Receipt file"
            hint="PDF, JPEG, PNG or WebP; up to 10 MB."
          >
            <Input
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              onChange={(event) => {
                setReceipt(event.target.files?.[0] ?? null);
              }}
              required
            />
          </Field>
          <Field label="Business purpose">
            <Input
              value={memo}
              onChange={(event) => {
                setMemo(event.target.value);
              }}
              maxLength={2000}
              required
            />
          </Field>
          <Button disabled={busy || !team?.requesterPersonId || !receipt}>
            {busy ? 'Submitting…' : 'Submit for approval'}
          </Button>
          {!team?.requesterPersonId ? (
            <p>Only an active team treasurer can submit reimbursements.</p>
          ) : null}
        </form>
      </Card>
      <Card>
        <h2>Reimbursement status</h2>
        <ul className="team-finance-portal__requests">
          {requests.map((request) => (
            <li key={request.id}>
              <strong>
                {money(request.amountCents)} · {request.category}
              </strong>
              <span>{request.memo}</span>
              <span>{request.status}</span>
            </li>
          ))}
          {requests.length === 0 ? (
            <li>No reimbursement requests have been submitted.</li>
          ) : null}
        </ul>
      </Card>
    </main>
  );
}
