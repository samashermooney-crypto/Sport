import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';

import { apiGet, apiPatch, apiPost } from '../../api/client';
import {
  Button,
  Card,
  DataTable,
  Field,
  Input,
  PageHeader,
  Select,
} from '../../ui';
import type { Column } from '../../ui';

import './team-finance.css';

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
const assessmentSchema = z.strictObject({
  id: uuid,
  teamSeasonId: uuid,
  perPlayerCents: z.number().int().positive(),
  dueOn: z.iso.date(),
  installmentTemplateId: uuid.nullable().optional(),
  status: z.enum(['draft', 'issued', 'canceled']),
  version: z.number().int().positive(),
});
const assessmentsSchema = z.strictObject({
  assessments: z.array(assessmentSchema),
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
const templateSchema = z.strictObject({
  id: uuid,
  name: z.string(),
  deposit: z.unknown(),
  schedule: z.unknown(),
  minAmountCents: z.number().int().nonnegative(),
  autopayRequired: z.boolean(),
  allowedMethods: z.array(z.enum(['card', 'us_bank_account'])),
  version: z.number().int().positive(),
  active: z.boolean(),
});
const templatesSchema = z.strictObject({ templates: z.array(templateSchema) });
const issueSchema = z.strictObject({
  assessmentId: uuid,
  issued: z.number().int().nonnegative(),
  invoices: z.array(z.unknown()),
});
type LedgerEntry = z.output<typeof ledgerSchema>['entries'][number];
type TeamLedger = z.output<typeof ledgersSchema>['ledgers'][number] & {
  id: string;
};
type Assessment = z.output<typeof assessmentSchema>;
type Reimbursement = z.output<typeof reimbursementSchema>;

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function TeamFinanceConsole({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  const base = `/team-finance/orgs/${encodeURIComponent(orgId)}`;
  const [teams, setTeams] = useState<TeamLedger[]>([]);
  const [selectedTeam, setSelectedTeam] = useState('');
  const [ledger, setLedger] = useState<z.output<typeof ledgerSchema> | null>(
    null,
  );
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [reimbursements, setReimbursements] = useState<Reimbursement[]>([]);
  const [templates, setTemplates] = useState<z.output<typeof templateSchema>[]>(
    [],
  );
  const [perPlayer, setPerPlayer] = useState('450.00');
  const [dueOn, setDueOn] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const team = teams.find((item) => item.teamSeasonId === selectedTeam);

  const refreshTeams = useCallback(async () => {
    try {
      const [ledgerResult, templateResult] = await Promise.all([
        apiGet(`${base}/ledgers`, ledgersSchema),
        apiGet(
          `/finance/orgs/${encodeURIComponent(orgId)}/installment-templates`,
          templatesSchema,
        ),
      ]);
      setTeams(
        ledgerResult.ledgers.map((row) => ({ ...row, id: row.teamSeasonId })),
      );
      setTemplates(templateResult.templates.filter((item) => item.active));
      setSelectedTeam((current) =>
        ledgerResult.ledgers.some((item) => item.teamSeasonId === current)
          ? current
          : (ledgerResult.ledgers[0]?.teamSeasonId ?? ''),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Team finance data is unavailable.',
      );
    }
  }, [base, orgId]);

  const refreshDetails = useCallback(async () => {
    if (!selectedTeam) {
      setLedger(null);
      setAssessments([]);
      setReimbursements([]);
      return;
    }
    const teamBase = `${base}/teams/${encodeURIComponent(selectedTeam)}`;
    try {
      const [ledgerResult, assessmentResult, reimbursementResult] =
        await Promise.all([
          apiGet(`${teamBase}/ledger`, ledgerSchema),
          apiGet(`${teamBase}/fee-assessments`, assessmentsSchema),
          apiGet(`${teamBase}/reimbursements`, reimbursementsSchema),
        ]);
      setLedger(ledgerResult);
      setAssessments(assessmentResult.assessments);
      setReimbursements(reimbursementResult.requests);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Team ledger is unavailable.',
      );
    }
  }, [base, selectedTeam]);

  useEffect(() => {
    void refreshTeams();
  }, [refreshTeams]);
  useEffect(() => {
    void refreshDetails();
  }, [refreshDetails]);

  async function assessFees(
    event: React.SubmitEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!selectedTeam || !dueOn) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPost(
        `${base}/teams/${encodeURIComponent(selectedTeam)}/fee-assessments`,
        {
          teamSeasonId: selectedTeam,
          perPlayerCents: Math.round(Number(perPlayer) * 100),
          dueOn,
          installmentTemplateId: templateId || null,
        },
        assessmentSchema,
      );
      setNotice('Team fee assessment created.');
      await Promise.all([refreshTeams(), refreshDetails()]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Assessment could not be created.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function issueFees(assessment: Assessment): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await apiPost(
        `${base}/fee-assessments/${encodeURIComponent(assessment.id)}/issue`,
        {},
        issueSchema,
      );
      setNotice(
        `${String(result.issued)} family invoice${result.issued === 1 ? '' : 's'} issued.`,
      );
      await Promise.all([refreshTeams(), refreshDetails()]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Team fees could not be issued.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function decide(
    request: Reimbursement,
    decision: 'approve' | 'reject',
  ): Promise<void> {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await apiPatch(
        `${base}/reimbursements/${encodeURIComponent(request.id)}`,
        {
          decision,
          expectedVersion: request.version,
        },
        reimbursementSchema,
      );
      setNotice(
        `Reimbursement ${decision === 'approve' ? 'approved' : 'rejected'}.`,
      );
      await Promise.all([refreshTeams(), refreshDetails()]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Reimbursement decision could not be saved.',
      );
    } finally {
      setBusy(false);
    }
  }

  function downloadLedger(): void {
    if (!ledger || !team) return;
    const rows = [
      ['Date', 'Direction', 'Category', 'Amount', 'Source', 'Memo'],
      ...ledger.entries.map((entry) => [
        entry.occurredOn,
        entry.direction,
        entry.category,
        (entry.amountCents / 100).toFixed(2),
        entry.source,
        entry.memo ?? '',
      ]),
    ];
    const content = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(
      new Blob([content], { type: 'text/csv;charset=utf-8' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${team.teamName.replace(/[^a-z0-9-]+/gi, '-')}-ledger.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const teamColumns: Column<TeamLedger>[] = [
    { key: 'team', label: 'Team', render: (row) => row.teamName },
    { key: 'program', label: 'Program', render: (row) => row.programName },
    {
      key: 'income',
      label: 'Income',
      render: (row) => money(row.incomeCents),
      sort: (row) => row.incomeCents,
    },
    {
      key: 'expenses',
      label: 'Expenses',
      render: (row) => money(row.expenseCents),
      sort: (row) => row.expenseCents,
    },
    {
      key: 'balance',
      label: 'Balance',
      render: (row) => money(row.balanceCents),
      sort: (row) => row.balanceCents,
    },
  ];
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
    {
      key: 'source',
      label: 'Source',
      render: (row) => row.source.replaceAll('_', ' '),
    },
    { key: 'memo', label: 'Memo', render: (row) => row.memo ?? '—' },
  ];

  return (
    <main className="console-home team-finance">
      <PageHeader
        kicker="TEAM FINANCES"
        title="Team finance"
        description="Assess fees, review reimbursements and track team income and expenses."
      />
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <Card>
        <Field label="Team">
          <Select
            aria-label="Team"
            value={selectedTeam}
            onChange={(event) => {
              setSelectedTeam(event.target.value);
            }}
          >
            {teams.map((row) => (
              <option key={row.teamSeasonId} value={row.teamSeasonId}>
                {row.programName} · {row.teamName}
              </option>
            ))}
          </Select>
        </Field>
        <DataTable
          rows={teams}
          columns={teamColumns}
          empty="No active team ledgers are available."
        />
      </Card>
      {selectedTeam && team ? (
        <>
          <section className="team-finance__summary" aria-label="Team balances">
            <Card>
              <h2>Income</h2>
              <p>{money(ledger?.incomeCents ?? team.incomeCents)}</p>
            </Card>
            <Card>
              <h2>Expenses</h2>
              <p>{money(ledger?.expenseCents ?? team.expenseCents)}</p>
            </Card>
            <Card>
              <h2>Balance</h2>
              <p>{money(ledger?.balanceCents ?? team.balanceCents)}</p>
            </Card>
          </section>
          <Card>
            <div className="team-finance__heading">
              <h2>Fee assessments</h2>
              <form
                onSubmit={(event) => {
                  void assessFees(event);
                }}
              >
                <Field label="Per-player fee in dollars">
                  <Input
                    aria-label="Per-player fee in dollars"
                    type="number"
                    min="1"
                    step="0.01"
                    value={perPlayer}
                    onChange={(event) => {
                      setPerPlayer(event.target.value);
                    }}
                    required
                  />
                </Field>
                <Field label="Due date">
                  <Input
                    aria-label="Due date"
                    type="date"
                    value={dueOn}
                    onChange={(event) => {
                      setDueOn(event.target.value);
                    }}
                    required
                  />
                </Field>
                <Field label="Installment schedule">
                  <Select
                    aria-label="Installment schedule"
                    value={templateId}
                    onChange={(event) => {
                      setTemplateId(event.target.value);
                    }}
                  >
                    <option value="">One payment</option>
                    {templates.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button disabled={busy || !dueOn}>Create assessment</Button>
              </form>
            </div>
            <ul
              className="team-finance__list"
              aria-label="Team fee assessments"
            >
              {assessments.map((assessment) => (
                <li key={assessment.id}>
                  <span>
                    {money(assessment.perPlayerCents)} per player · due{' '}
                    {assessment.dueOn} · {assessment.status}
                  </span>
                  {assessment.status === 'draft' ? (
                    <Button
                      secondary
                      disabled={busy}
                      onClick={() => {
                        void issueFees(assessment);
                      }}
                    >
                      Issue family invoices
                    </Button>
                  ) : null}
                </li>
              ))}
              {assessments.length === 0 ? (
                <li>No team fee assessments yet.</li>
              ) : null}
            </ul>
          </Card>
          <Card>
            <div className="team-finance__heading">
              <h2>Team ledger</h2>
              <Button secondary onClick={downloadLedger} disabled={!ledger}>
                Export CSV
              </Button>
            </div>
            <DataTable
              rows={ledger?.entries ?? []}
              columns={entryColumns}
              empty="No income or expense entries have posted."
            />
          </Card>
          <Card>
            <h2>Reimbursements</h2>
            <ul
              className="team-finance__list"
              aria-label="Reimbursement requests"
            >
              {reimbursements.map((request) => (
                <li key={request.id}>
                  <div>
                    <strong>
                      {money(request.amountCents)} · {request.category}
                    </strong>
                    <p>{request.memo}</p>
                    <p>Status: {request.status}</p>
                  </div>
                  {request.status === 'submitted' ? (
                    <div className="team-finance__actions">
                      <Button
                        disabled={busy}
                        onClick={() => {
                          void decide(request, 'approve');
                        }}
                      >
                        Approve
                      </Button>
                      <Button
                        secondary
                        disabled={busy}
                        onClick={() => {
                          void decide(request, 'reject');
                        }}
                      >
                        Reject
                      </Button>
                    </div>
                  ) : null}
                </li>
              ))}
              {reimbursements.length === 0 ? (
                <li>No reimbursement requests for this team.</li>
              ) : null}
            </ul>
          </Card>
        </>
      ) : null}
    </main>
  );
}
