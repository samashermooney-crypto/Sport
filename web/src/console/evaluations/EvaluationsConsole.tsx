import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { z } from 'zod';

import { apiGet, apiPost, apiPut } from '../../api/client';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
} from '../../ui';
import { AppShell } from '../../ui/shell';

import { captureEvaluationParticipantPhoto } from './evaluation-photo';
import './evaluations.css';

const eventSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.string(),
  normalization: z.string(),
  tryoutProgramId: z.string(),
  targetProgramId: z.string(),
  targetProgramName: z.string(),
  participantCount: z.number(),
  version: z.number(),
});
const eventsSchema = z.array(eventSchema);
const rubricItemSchema = z.object({
  key: z.string(),
  label: z.string(),
  weight: z.number(),
  scaleMin: z.number(),
  scaleMax: z.number(),
  positionSpecific: z.boolean(),
  positionKeys: z.array(z.string()),
});
type EvaluationGroupDraft = {
  name: string;
  ageMinMonths: string;
  ageMaxMonths: string;
  gender: 'open' | 'female' | 'male';
  positionKeys: string;
};
const programsSchema = z.array(
  z.object({
    id: z.uuid(),
    name: z.string(),
    mode: z.string(),
    sportProfileId: z.uuid(),
    sportProfileName: z.string(),
    rubric: z.array(rubricItemSchema),
    divisions: z.array(z.object({ id: z.uuid(), name: z.string() })),
    offerings: z.array(
      z.object({ id: z.uuid(), name: z.string(), priceCents: z.number() }),
    ),
  }),
);
const registrantsSchema = z.array(
  z.object({
    registrationId: z.uuid(),
    personId: z.uuid(),
    firstName: z.string(),
    lastName: z.string(),
    mediaConsent: z.boolean(),
    personVersion: z.number(),
    assigned: z.boolean(),
  }),
);
const evaluatorCandidatesSchema = z.array(
  z.object({
    accountId: z.uuid(),
    firstName: z.string(),
    lastName: z.string(),
  }),
);
const placementPreferencesSchema = z.array(
  z.object({
    personId: z.uuid(),
    firstName: z.string(),
    lastName: z.string(),
    friendRequestPersonId: z.uuid().nullable(),
    practiceLocation: z.string().nullable(),
    coachRating: z.number().nullable(),
    note: z.string().nullable(),
    source: z.string(),
    version: z.number(),
  }),
);
const setupSchema = z.object({
  canManagePhotos: z.boolean(),
  event: z.looseObject({
    id: z.uuid(),
    name: z.string(),
    status: z.string(),
    normalization: z.string(),
    tryout_program_id: z.uuid(),
    target_program_id: z.uuid(),
  }),
  groups: z.array(
    z.looseObject({
      id: z.uuid(),
      name: z.string(),
      ageMinMonths: z.number().nullable(),
      ageMaxMonths: z.number().nullable(),
      gender: z.string().nullable(),
      positionKeys: z.array(z.string()),
    }),
  ),
  sessions: z.array(
    z.looseObject({
      id: z.uuid(),
      groupId: z.string().nullable(),
      name: z.string(),
      startsAt: z.string(),
      endsAt: z.string(),
      timezone: z.string(),
    }),
  ),
  participants: z.array(
    z.looseObject({
      id: z.uuid(),
      personId: z.uuid(),
      registrationId: z.uuid(),
      groupId: z.uuid(),
      groupName: z.string(),
      sessionId: z.string().nullable(),
      bibNumber: z.number(),
      checkInStatus: z.string(),
      firstName: z.string(),
      lastName: z.string(),
      mediaConsent: z.boolean(),
      personVersion: z.number(),
    }),
  ),
});
const resultsSchema = z.array(
  z.looseObject({
    participantId: z.uuid(),
    group: z.string(),
    firstName: z.string(),
    lastName: z.string(),
    composite: z.number().nullable(),
    rankInGroup: z.number().nullable(),
    evaluatorCount: z.number(),
    missingCriteria: z.array(z.string()),
  }),
);
const consistencySchema = z.array(
  z.looseObject({
    evaluatorId: z.uuid(),
    evaluatorName: z.string(),
    criterionKey: z.string(),
    scoreCount: z.number(),
    mean: z.number(),
    standard_deviation: z.number(),
  }),
);
const boardSchema = z.object({
  id: z.uuid(),
  targetProgramId: z.uuid(),
  divisionId: z.string().nullable(),
  seed: z.number(),
  assignments: z.record(z.string(), z.string()),
  metrics: z.array(
    z.looseObject({
      teamId: z.string(),
      size: z.number(),
      meanRating: z.number(),
      positionCoverageViolations: z.number(),
      preferenceMisses: z.number(),
    }),
  ),
  objective: z.number(),
});
const boardDetailSchema = z.object({
  id: z.uuid(),
  status: z.string(),
  metrics: z.array(
    z.looseObject({
      teamId: z.uuid(),
      size: z.number(),
      meanRating: z.number(),
      positionCoverageViolations: z.number(),
      preferenceMisses: z.number(),
    }),
  ),
  placements: z.array(
    z.looseObject({
      id: z.uuid(),
      personId: z.uuid(),
      firstName: z.string(),
      lastName: z.string(),
      teamSeasonId: z.uuid(),
      teamName: z.string(),
      rating: z.coerce.number().nullable(),
      locked: z.boolean(),
      status: z.string(),
      version: z.number(),
    }),
  ),
});
const offerDashboardSchema = z.object({
  boardId: z.uuid(),
  status: z.string(),
  teams: z.array(
    z.looseObject({
      teamSeasonId: z.uuid(),
      teamName: z.string(),
      rosterLimit: z.number().nullable(),
      sent: z.number(),
      accepted: z.number(),
      declined: z.number(),
      expired: z.number(),
      withdrawn: z.number(),
      placed: z.number(),
    }),
  ),
  nextInLine: z.array(
    z.looseObject({
      personId: z.uuid(),
      firstName: z.string(),
      lastName: z.string(),
      group: z.string(),
      composite: z.number().nullable(),
    }),
  ),
});
const responseSchema = z.looseObject({
  id: z.string().optional(),
  status: z.string().optional(),
});

async function downloadEvaluationCsv(
  orgId: string,
  eventId: string,
): Promise<void> {
  const response = await fetch(
    `/api/v1/evaluations/orgs/${orgId}/events/${eventId}/export.csv`,
    {
      method: 'POST',
      credentials: 'include',
      headers: {
        'X-Athlentry-Request': '1',
        'Content-Type': 'application/json',
      },
      body: '{}',
    },
  );
  if (!response.ok)
    throw new Error(
      'CSV export is unavailable. Complete step-up authentication and try again.',
    );
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = `evaluation-${eventId}.csv`;
  link.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

function OrgLayout({
  orgId,
  children,
  title,
  description,
}: {
  orgId: string;
  children: React.ReactNode;
  title: string;
  description: string;
}) {
  const workspace = useQuery({
    queryKey: ['orgs', orgId, 'workspace'],
    queryFn: () =>
      apiGet(
        `/orgs/${orgId}/workspace`,
        z.looseObject({ name: z.string().optional() }),
      ),
  });
  return (
    <AppShell
      orgName={workspace.data?.name ?? 'Athlentry'}
      navigation={[
        {
          label: 'Manage',
          items: [
            { label: 'Home', to: `/console/orgs/${orgId}` },
            { label: 'Evaluations', to: `/console/orgs/${orgId}/evaluations` },
          ],
        },
      ]}
      mobileTabs={[
        { label: 'Home', to: `/console/orgs/${orgId}` },
        { label: 'Evaluations', to: `/console/orgs/${orgId}/evaluations` },
      ]}
    >
      <main className="console-home evaluation-console">
        <PageHeader
          kicker="PLAYER DEVELOPMENT"
          title={title}
          description={description}
        />
        {children}
      </main>
    </AppShell>
  );
}

export function EvaluationList(): React.JSX.Element {
  const { orgId = '' } = useParams();
  const queryClient = useQueryClient();
  const draggedPlacementPerson = useRef<string | null>(null);
  const [name, setName] = useState('');
  const [tryoutProgramId, setTryoutProgramId] = useState('');
  const [targetProgramId, setTargetProgramId] = useState('');
  const [criteria, setCriteria] = useState<z.infer<typeof rubricItemSchema>[]>(
    [],
  );
  const [groups, setGroups] = useState<EvaluationGroupDraft[]>([
    {
      name: 'Open',
      ageMinMonths: '',
      ageMaxMonths: '',
      gender: 'open',
      positionKeys: '',
    },
  ]);
  const [shareResults, setShareResults] = useState(false);
  const [normalization, setNormalization] = useState<
    'none' | 'z_score_per_evaluator'
  >('z_score_per_evaluator');
  const [error, setError] = useState('');
  const [recProgramId, setRecProgramId] = useState('');
  const [recDivisionId, setRecDivisionId] = useState('');
  const [recBoardId, setRecBoardId] = useState('');
  const [recSeed, setRecSeed] = useState('1');
  const [recSiblingsTogether, setRecSiblingsTogether] = useState(true);
  const [recReturningStay, setRecReturningStay] = useState(false);
  const [recMoveTargets, setRecMoveTargets] = useState<Record<string, string>>(
    {},
  );
  const [coachRatingDrafts, setCoachRatingDrafts] = useState<
    Record<string, string>
  >({});
  const [recError, setRecError] = useState('');
  const programs = useQuery({
    queryKey: ['evaluation-programs', orgId],
    queryFn: () =>
      apiGet(`/evaluations/orgs/${orgId}/programs`, programsSchema),
    enabled: Boolean(orgId),
  });
  const events = useQuery({
    queryKey: ['evaluations', orgId],
    queryFn: () => apiGet(`/evaluations/orgs/${orgId}/events`, eventsSchema),
    enabled: Boolean(orgId),
  });
  const recProgram = programs.data?.find(
    (program) => program.id === recProgramId,
  );
  const recBoard = useQuery({
    queryKey: ['rec-placement-board', orgId, recBoardId],
    queryFn: () =>
      apiGet(
        `/evaluations/orgs/${orgId}/boards/${recBoardId}`,
        boardDetailSchema,
      ),
    enabled: Boolean(recBoardId),
  });
  const recDashboard = useQuery({
    queryKey: ['rec-placement-dashboard', orgId, recBoardId],
    queryFn: () =>
      apiGet(
        `/evaluations/orgs/${orgId}/boards/${recBoardId}/offers`,
        offerDashboardSchema,
      ),
    enabled: Boolean(recBoardId),
  });
  const recPlacementPreferences = useQuery({
    queryKey: ['rec-placement-preferences', orgId, recProgramId],
    queryFn: () =>
      apiGet(
        `/evaluations/orgs/${orgId}/programs/${recProgramId}/placement-preferences`,
        placementPreferencesSchema,
      ),
    enabled: Boolean(recProgramId),
  });
  const tryoutProgram = programs.data?.find(
    (program) => program.id === tryoutProgramId,
  );
  const targetProgram = programs.data?.find(
    (program) => program.id === targetProgramId,
  );
  const rubricForTryout = useMemo(
    () =>
      programs.data?.find((program) => program.id === tryoutProgramId)
        ?.rubric ?? [],
    [programs.data, tryoutProgramId],
  );
  const targetOptions = useMemo(
    () =>
      (programs.data ?? []).filter(
        (program) =>
          ['club', 'league'].includes(program.mode) &&
          program.sportProfileId === tryoutProgram?.sportProfileId,
      ),
    [programs.data, tryoutProgram?.sportProfileId],
  );
  useEffect(() => {
    if (!tryoutProgramId) return;
    setCriteria(
      rubricForTryout.map((item) => ({
        ...item,
        positionKeys: [...item.positionKeys],
      })),
    );
    setTargetProgramId((current) =>
      targetOptions.some((program) => program.id === current) ? current : '',
    );
  }, [rubricForTryout, targetOptions, tryoutProgramId]);
  const create = useMutation({
    mutationFn: () =>
      apiPost(
        `/evaluations/orgs/${orgId}/events`,
        {
          name,
          tryoutProgramId,
          targetProgramId,
          normalization,
          shareResultsWithFamilies: shareResults,
          criteria,
          groups: groups.map((group) => ({
            name: group.name,
            ageMinMonths: group.ageMinMonths
              ? Number(group.ageMinMonths)
              : null,
            ageMaxMonths: group.ageMaxMonths
              ? Number(group.ageMaxMonths)
              : null,
            gender: group.gender,
            positionKeys: group.positionKeys
              .split(',')
              .map((value) => value.trim())
              .filter(Boolean),
          })),
        },
        responseSchema,
      ),
    onSuccess: async () => {
      setName('');
      setError('');
      await queryClient.invalidateQueries({ queryKey: ['evaluations', orgId] });
    },
    onError: (cause) => {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Evaluation event could not be created.',
      );
    },
  });
  const createRecBoard = useMutation({
    mutationFn: () =>
      apiPost(
        `/evaluations/orgs/${orgId}/programs/${recProgramId}/boards`,
        {
          divisionId: recDivisionId,
          evaluationGroupId: null,
          seed: Number(recSeed),
          siblingsTogether: recSiblingsTogether,
          returningStay: recReturningStay,
          positionMinimums: {},
        },
        boardSchema,
      ),
    onSuccess: (value) => {
      setRecError('');
      setRecBoardId(value.id);
      setRecMoveTargets({});
    },
    onError: (cause) => {
      setRecError(
        cause instanceof Error
          ? cause.message
          : 'Rec-league placement board could not be built.',
      );
    },
  });
  const saveCoachRating = useMutation({
    mutationFn: (input: {
      personId: string;
      friendRequestPersonId: string | null;
      practiceLocation: string | null;
      coachRating: number | null;
      note: string | null;
    }) =>
      apiPut(
        `/evaluations/orgs/${orgId}/programs/${recProgramId}/placement-preferences`,
        { ...input, source: 'staff' },
        responseSchema,
      ),
    onSuccess: async (_, input) => {
      setRecError('');
      await queryClient.invalidateQueries({
        queryKey: ['rec-placement-preferences', orgId, recProgramId],
      });
      setCoachRatingDrafts((current) => ({
        ...current,
        [input.personId]:
          input.coachRating === null ? '' : String(input.coachRating),
      }));
    },
    onError: (cause) => {
      setRecError(
        cause instanceof Error
          ? cause.message
          : 'Coach rating could not be saved.',
      );
    },
  });
  const moveRecPlacement = useMutation({
    mutationFn: (placement: {
      personId: string;
      teamSeasonId: string;
      version: number;
    }) =>
      apiPost(
        `/evaluations/orgs/${orgId}/boards/${recBoardId}/placements/move`,
        {
          personId: placement.personId,
          teamSeasonId: placement.teamSeasonId,
          expectedVersion: placement.version,
        },
        responseSchema,
      ),
    onSuccess: async () => {
      await recBoard.refetch();
    },
    onError: (cause) => {
      setRecError(
        cause instanceof Error
          ? cause.message
          : 'Rec-league placement could not be moved.',
      );
    },
  });
  const lockRecPlacement = useMutation({
    mutationFn: (personId: string) =>
      apiPost(
        `/evaluations/orgs/${orgId}/boards/${recBoardId}/placements/${personId}/lock`,
        { reason: 'Director placement decision' },
        responseSchema,
      ),
    onSuccess: async () => {
      await recBoard.refetch();
    },
    onError: (cause) => {
      setRecError(
        cause instanceof Error
          ? cause.message
          : 'Rec-league placement could not be locked.',
      );
    },
  });
  const publishRecBoard = useMutation({
    mutationFn: () =>
      apiPost(
        `/evaluations/orgs/${orgId}/boards/${recBoardId}/publish`,
        {},
        responseSchema,
      ),
    onSuccess: async () => {
      await recBoard.refetch();
    },
    onError: (cause) => {
      setRecError(
        cause instanceof Error
          ? cause.message
          : 'Rec-league placements could not be published.',
      );
    },
  });
  const rubricValid =
    criteria.length > 0 &&
    criteria.every(
      (item) =>
        item.label.trim() &&
        item.weight > 0 &&
        item.scaleMax > item.scaleMin &&
        (!item.positionSpecific || item.positionKeys.length > 0),
    );
  const updateGroup = (index: number, patch: Partial<EvaluationGroupDraft>) => {
    setGroups((current) =>
      current.map((group, at) =>
        at === index ? { ...group, ...patch } : group,
      ),
    );
  };
  return (
    <OrgLayout
      orgId={orgId}
      title="Evaluations and tryouts"
      description="Set up a tryout, review results and build balanced teams."
    >
      <section className="evaluation-grid">
        <Card>
          <h2>Create an evaluation</h2>
          <p>
            Use a tryout program and the target program you will place athletes
            into.
          </p>
          <form
            className="evaluation-form"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <Field label="Event name" required>
              <Input
                required
                maxLength={160}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </Field>
            <Field label="Tryout program" required>
              <Select
                required
                value={tryoutProgramId}
                onChange={(event) => {
                  setTryoutProgramId(event.target.value);
                }}
              >
                <option value="">Select a tryout program</option>
                {(programs.data ?? [])
                  .filter((program) => program.mode === 'tryout')
                  .map((program) => (
                    <option key={program.id} value={program.id}>
                      {program.name} · {program.sportProfileName}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Target program" required>
              <Select
                required
                value={targetProgramId}
                onChange={(event) => {
                  setTargetProgramId(event.target.value);
                }}
                disabled={!tryoutProgramId}
              >
                <option value="">Select a target program</option>
                {targetOptions.map((program) => (
                  <option key={program.id} value={program.id}>
                    {program.name}
                  </option>
                ))}
              </Select>
            </Field>
            {programs.isError && <p role="alert">{programs.error.message}</p>}
            <Field label="Normalization">
              <Select
                value={normalization}
                onChange={(event) => {
                  setNormalization(
                    event.target.value as 'none' | 'z_score_per_evaluator',
                  );
                }}
              >
                <option value="z_score_per_evaluator">
                  Normalize scores per evaluator
                </option>
                <option value="none">Use raw scores</option>
              </Select>
            </Field>
            <Field label="Share results with families">
              <Input
                type="checkbox"
                checked={shareResults}
                onChange={(event) => {
                  setShareResults(event.target.checked);
                }}
              />
            </Field>
            <Card className="evaluation-rubric">
              <h3>
                Sport profile rubric ·{' '}
                {tryoutProgram?.sportProfileName ?? 'Select a tryout program'}
              </h3>
              {criteria.length ? (
                criteria.map((item, index) => (
                  <div
                    className="evaluation-criterion"
                    key={`${item.key}-${String(index)}`}
                  >
                    <Field label={`Criterion ${String(index + 1)} name`}>
                      <Input
                        value={item.label}
                        onChange={(event) => {
                          setCriteria((current) =>
                            current.map((criterion, at) =>
                              at === index
                                ? { ...criterion, label: event.target.value }
                                : criterion,
                            ),
                          );
                        }}
                        required
                      />
                    </Field>
                    <Field label="Weight">
                      <Input
                        type="number"
                        min="0.01"
                        max="100"
                        step="0.01"
                        value={item.weight}
                        onChange={(event) => {
                          setCriteria((current) =>
                            current.map((criterion, at) =>
                              at === index
                                ? {
                                    ...criterion,
                                    weight: Number(event.target.value),
                                  }
                                : criterion,
                            ),
                          );
                        }}
                        required
                      />
                    </Field>
                    <Field label="Minimum score">
                      <Input
                        type="number"
                        value={item.scaleMin}
                        onChange={(event) => {
                          setCriteria((current) =>
                            current.map((criterion, at) =>
                              at === index
                                ? {
                                    ...criterion,
                                    scaleMin: Number(event.target.value),
                                  }
                                : criterion,
                            ),
                          );
                        }}
                        required
                      />
                    </Field>
                    <Field label="Maximum score">
                      <Input
                        type="number"
                        value={item.scaleMax}
                        onChange={(event) => {
                          setCriteria((current) =>
                            current.map((criterion, at) =>
                              at === index
                                ? {
                                    ...criterion,
                                    scaleMax: Number(event.target.value),
                                  }
                                : criterion,
                            ),
                          );
                        }}
                        required
                      />
                    </Field>
                    <Field label="Position-specific criterion">
                      <Input
                        type="checkbox"
                        checked={item.positionSpecific}
                        onChange={(event) => {
                          setCriteria((current) =>
                            current.map((criterion, at) =>
                              at === index
                                ? {
                                    ...criterion,
                                    positionSpecific: event.target.checked,
                                  }
                                : criterion,
                            ),
                          );
                        }}
                      />
                    </Field>
                    {item.positionSpecific && (
                      <Field label="Positions for this criterion">
                        <Input
                          value={item.positionKeys.join(', ')}
                          onChange={(event) => {
                            setCriteria((current) =>
                              current.map((criterion, at) =>
                                at === index
                                  ? {
                                      ...criterion,
                                      positionKeys: event.target.value
                                        .split(',')
                                        .map((value) => value.trim())
                                        .filter(Boolean),
                                    }
                                  : criterion,
                              ),
                            );
                          }}
                          placeholder="keeper, defender"
                          required
                        />
                      </Field>
                    )}
                    <Button
                      secondary
                      type="button"
                      onClick={() => {
                        setCriteria((current) =>
                          current.filter((_, at) => at !== index),
                        );
                      }}
                    >
                      Remove criterion
                    </Button>
                  </div>
                ))
              ) : (
                <p>
                  The selected sport profile has no rubric. Add a criterion
                  before creating the event.
                </p>
              )}
              <Button
                secondary
                type="button"
                onClick={() => {
                  const key = `criterion_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
                  setCriteria((current) => [
                    ...current,
                    {
                      key,
                      label: 'New criterion',
                      weight: 1,
                      scaleMin: 1,
                      scaleMax: 5,
                      positionSpecific: false,
                      positionKeys: [],
                    },
                  ]);
                }}
              >
                Add criterion
              </Button>
            </Card>
            <Card className="evaluation-group">
              <h3>Evaluation groups</h3>
              {groups.map((group, index) => (
                <div className="evaluation-group-draft" key={String(index)}>
                  <h4>{group.name || `Group ${String(index + 1)}`}</h4>
                  <Field label="Group name">
                    <Input
                      value={group.name}
                      onChange={(event) => {
                        updateGroup(index, { name: event.target.value });
                      }}
                      required
                    />
                  </Field>
                  <Field label="Minimum age (months)">
                    <Input
                      type="number"
                      min="0"
                      max="240"
                      value={group.ageMinMonths}
                      onChange={(event) => {
                        updateGroup(index, {
                          ageMinMonths: event.target.value,
                        });
                      }}
                    />
                  </Field>
                  <Field label="Maximum age (months)">
                    <Input
                      type="number"
                      min="0"
                      max="240"
                      value={group.ageMaxMonths}
                      onChange={(event) => {
                        updateGroup(index, {
                          ageMaxMonths: event.target.value,
                        });
                      }}
                    />
                  </Field>
                  <Field label="Competition gender">
                    <Select
                      value={group.gender}
                      onChange={(event) => {
                        updateGroup(index, {
                          gender: event.target
                            .value as EvaluationGroupDraft['gender'],
                        });
                      }}
                    >
                      <option value="open">Open</option>
                      <option value="female">Female</option>
                      <option value="male">Male</option>
                    </Select>
                  </Field>
                  <Field label="Positions (comma separated)">
                    <Input
                      value={group.positionKeys}
                      onChange={(event) => {
                        updateGroup(index, {
                          positionKeys: event.target.value,
                        });
                      }}
                    />
                  </Field>
                  <Button
                    secondary
                    type="button"
                    disabled={groups.length === 1}
                    onClick={() => {
                      setGroups((current) =>
                        current.filter((_, at) => at !== index),
                      );
                    }}
                  >
                    Remove group
                  </Button>
                </div>
              ))}
              <Button
                secondary
                type="button"
                onClick={() => {
                  setGroups((current) => [
                    ...current,
                    {
                      name: `Group ${String(current.length + 1)}`,
                      ageMinMonths: '',
                      ageMaxMonths: '',
                      gender: 'open',
                      positionKeys: '',
                    },
                  ]);
                }}
              >
                Add group
              </Button>
            </Card>
            {error && (
              <p role="alert" className="field-error">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={
                create.isPending ||
                !rubricValid ||
                !targetProgram ||
                groups.some(
                  (group) =>
                    !group.name.trim() ||
                    (group.ageMinMonths &&
                      group.ageMaxMonths &&
                      Number(group.ageMaxMonths) < Number(group.ageMinMonths)),
                )
              }
            >
              {create.isPending ? 'Creating…' : 'Create evaluation'}
            </Button>
          </form>
        </Card>
        <Card>
          <h2>Evaluation events</h2>
          {events.isPending ? (
            <p role="status">Loading events…</p>
          ) : events.isError ? (
            <p role="alert">{events.error.message}</p>
          ) : events.data.length ? (
            <ul className="evaluation-event-list">
              {events.data.map((item) => (
                <li key={item.id}>
                  <div>
                    <Link to={`/console/orgs/${orgId}/evaluations/${item.id}`}>
                      {item.name}
                    </Link>
                    <p>
                      {item.targetProgramName} · {item.participantCount}{' '}
                      athletes
                    </p>
                  </div>
                  <Badge tone={item.status === 'published' ? 'ok' : 'neutral'}>
                    {item.status}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p>No evaluation events yet.</p>
          )}
        </Card>
      </section>
      <Card className="evaluation-group">
        <h2>Rec-league team formation</h2>
        <p>
          Balance confirmed registrations by school, family practice
          preferences, mutual friends, siblings and returning-team choices.
        </p>
        <div className="evaluation-grid">
          <Field label="League program" required>
            <Select
              required
              value={recProgramId}
              onChange={(event) => {
                setRecProgramId(event.target.value);
                setRecDivisionId('');
                setRecBoardId('');
              }}
            >
              <option value="">Select a league program</option>
              {(programs.data ?? [])
                .filter((program) => program.mode === 'league')
                .map((program) => (
                  <option key={program.id} value={program.id}>
                    {program.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Division" required>
            <Select
              required
              value={recDivisionId}
              onChange={(event) => {
                setRecDivisionId(event.target.value);
                setRecBoardId('');
              }}
              disabled={!recProgramId}
            >
              <option value="">Select a division</option>
              {(recProgram?.divisions ?? []).map((division) => (
                <option key={division.id} value={division.id}>
                  {division.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Deterministic seed">
            <Input
              inputMode="numeric"
              value={recSeed}
              onChange={(event) => {
                setRecSeed(event.target.value);
              }}
            />
          </Field>
          <Field label="Keep siblings together">
            <Input
              type="checkbox"
              checked={recSiblingsTogether}
              onChange={(event) => {
                setRecSiblingsTogether(event.target.checked);
              }}
            />
          </Field>
          <Field label="Keep returning players with their prior team">
            <Input
              type="checkbox"
              checked={recReturningStay}
              onChange={(event) => {
                setRecReturningStay(event.target.checked);
              }}
            />
          </Field>
        </div>
        <Button
          onClick={() => {
            createRecBoard.mutate();
          }}
          disabled={createRecBoard.isPending || !recProgramId || !recDivisionId}
        >
          {createRecBoard.isPending ? 'Balancing…' : 'Build rec-league board'}
        </Button>
        {recError && (
          <p role="alert" className="field-error">
            {recError}
          </p>
        )}
        {recProgramId && (
          <section className="evaluation-coach-ratings">
            <h3>Prior-season coach ratings</h3>
            <p>
              Record optional coach-supplied 1–5 ratings for confirmed players.
              A rating helps the rec-league board balance teams.
            </p>
            {recPlacementPreferences.isPending ? (
              <p role="status">Loading confirmed players…</p>
            ) : recPlacementPreferences.isError ? (
              <p role="alert">{recPlacementPreferences.error.message}</p>
            ) : recPlacementPreferences.data.length ? (
              recPlacementPreferences.data.map((row) => {
                const draft =
                  coachRatingDrafts[row.personId] ??
                  (row.coachRating === null ? '' : String(row.coachRating));
                const current =
                  row.coachRating === null ? '' : String(row.coachRating);
                const value = draft === '' ? null : Number(draft);
                const invalid =
                  value !== null &&
                  (!Number.isInteger(value) || value < 1 || value > 5);
                return (
                  <div
                    className="evaluation-placement"
                    key={row.personId}
                    role="group"
                    aria-label={`Prior-season rating for ${row.firstName} ${row.lastName}`}
                  >
                    <span>
                      {row.firstName} {row.lastName}
                    </span>
                    <div className="evaluation-move-controls">
                      <Field
                        label={`Coach rating for ${row.firstName} ${row.lastName}`}
                      >
                        <Input
                          type="number"
                          min="1"
                          max="5"
                          step="1"
                          value={draft}
                          onChange={(event) => {
                            setCoachRatingDrafts((currentDrafts) => ({
                              ...currentDrafts,
                              [row.personId]: event.target.value,
                            }));
                          }}
                        />
                      </Field>
                      <Button
                        type="button"
                        disabled={
                          saveCoachRating.isPending ||
                          invalid ||
                          draft === current
                        }
                        onClick={() => {
                          if (invalid) return;
                          saveCoachRating.mutate({
                            personId: row.personId,
                            friendRequestPersonId: row.friendRequestPersonId,
                            practiceLocation: row.practiceLocation,
                            coachRating: value,
                            note: row.note,
                          });
                        }}
                      >
                        Save rating
                      </Button>
                    </div>
                  </div>
                );
              })
            ) : (
              <p>No confirmed players to rate yet.</p>
            )}
          </section>
        )}
        {recBoard.data && (
          <>
            <h3>Draft assignments</h3>
            {recBoard.data.status === 'draft' && (
              <p>
                Drag a player onto a teammate to move them to that team, or use
                the team selector and Move button with a keyboard.
              </p>
            )}
            <div
              className="evaluation-table-wrap"
              role="region"
              aria-label="Placement team balance"
              tabIndex={0}
            >
              <table>
                <thead>
                  <tr>
                    <th>Team</th>
                    <th>Players</th>
                    <th>Mean rating</th>
                    <th>Position gaps</th>
                    <th>Preference misses</th>
                  </tr>
                </thead>
                <tbody>
                  {recBoard.data.metrics.map((metric) => (
                    <tr key={metric.teamId}>
                      <td>
                        {recDashboard.data?.teams.find(
                          (team) => team.teamSeasonId === metric.teamId,
                        )?.teamName ?? metric.teamId}
                      </td>
                      <td>{metric.size}</td>
                      <td>{metric.meanRating.toFixed(2)}</td>
                      <td>{metric.positionCoverageViolations}</td>
                      <td>{metric.preferenceMisses}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {recBoard.data.placements.map((row) => (
              <div
                className="evaluation-placement"
                key={row.personId}
                draggable={recBoard.data.status === 'draft' && !row.locked}
                onDragStart={(event) => {
                  draggedPlacementPerson.current = row.personId;
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', row.personId);
                }}
                onDragEnd={() => {
                  draggedPlacementPerson.current = null;
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const personId =
                    draggedPlacementPerson.current ||
                    event.dataTransfer.getData('text/plain');
                  draggedPlacementPerson.current = null;
                  const source = recBoard.data.placements.find(
                    (placement) => placement.personId === personId,
                  );
                  if (
                    !source ||
                    source.locked ||
                    source.personId === row.personId ||
                    source.teamSeasonId === row.teamSeasonId
                  )
                    return;
                  moveRecPlacement.mutate({
                    personId,
                    teamSeasonId: row.teamSeasonId,
                    version: source.version,
                  });
                }}
              >
                <span>
                  {row.firstName} {row.lastName} → {row.teamName}
                </span>
                <div className="evaluation-move-controls">
                  {recBoard.data.status === 'draft' && (
                    <>
                      <Select
                        aria-label={`Move ${row.firstName} ${row.lastName} to team`}
                        value={recMoveTargets[row.personId] ?? row.teamSeasonId}
                        onChange={(event) => {
                          setRecMoveTargets((current) => ({
                            ...current,
                            [row.personId]: event.target.value,
                          }));
                        }}
                      >
                        {(recDashboard.data?.teams ?? []).map((team) => (
                          <option
                            key={team.teamSeasonId}
                            value={team.teamSeasonId}
                          >
                            {team.teamName}
                          </option>
                        ))}
                      </Select>
                      <Button
                        secondary
                        type="button"
                        disabled={
                          moveRecPlacement.isPending ||
                          row.locked ||
                          (recMoveTargets[row.personId] ?? row.teamSeasonId) ===
                            row.teamSeasonId
                        }
                        onClick={() => {
                          moveRecPlacement.mutate({
                            personId: row.personId,
                            teamSeasonId:
                              recMoveTargets[row.personId] ?? row.teamSeasonId,
                            version: row.version,
                          });
                        }}
                      >
                        Move
                      </Button>
                      <Button
                        secondary
                        type="button"
                        disabled={row.locked || lockRecPlacement.isPending}
                        onClick={() => {
                          lockRecPlacement.mutate(row.personId);
                        }}
                      >
                        Lock
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
            {recBoard.data.status === 'draft' && (
              <Button
                onClick={() => {
                  publishRecBoard.mutate();
                }}
                disabled={publishRecBoard.isPending}
              >
                Publish rec-league teams
              </Button>
            )}
          </>
        )}
      </Card>
    </OrgLayout>
  );
}

export function EvaluationOperations(): React.JSX.Element {
  const { orgId = '', eventId = '' } = useParams();
  const queryClient = useQueryClient();
  const [sessionName, setSessionName] = useState('Tryout session');
  const [sessionStart, setSessionStart] = useState('');
  const [sessionEnd, setSessionEnd] = useState('');
  const [registrationId, setRegistrationId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [evaluatorSessionId, setEvaluatorSessionId] = useState('');
  const [evaluatorAccountId, setEvaluatorAccountId] = useState('');
  const [positionKeys, setPositionKeys] = useState('');
  const [divisionId, setDivisionId] = useState('');
  const [boardId, setBoardId] = useState('');
  const [showConsistency, setShowConsistency] = useState(false);
  const [seed, setSeed] = useState('1');
  const [siblingsTogether, setSiblingsTogether] = useState(true);
  const [returningStay, setReturningStay] = useState(false);
  const [minimumPosition, setMinimumPosition] = useState('');
  const [minimumPositionCount, setMinimumPositionCount] = useState('');
  const [offerOfferingId, setOfferOfferingId] = useState('');
  const [offerDeposit, setOfferDeposit] = useState('');
  const [offerExpires, setOfferExpires] = useState('');
  const [moveTargets, setMoveTargets] = useState<Record<string, string>>({});
  const [checkInSearch, setCheckInSearch] = useState('');
  const [registrationQr, setRegistrationQr] = useState('');
  const [notice, setNotice] = useState('');
  const [participantPhotos, setParticipantPhotos] = useState<
    Record<string, File | null>
  >({});
  const [photoInputVersion, setPhotoInputVersion] = useState(0);
  const draggedPlacementPerson = useRef<string | null>(null);
  const setup = useQuery({
    queryKey: ['evaluation-setup', orgId, eventId],
    queryFn: () =>
      apiGet(`/evaluations/orgs/${orgId}/events/${eventId}/setup`, setupSchema),
    enabled: Boolean(orgId && eventId),
  });
  const registrants = useQuery({
    queryKey: ['evaluation-registrants', orgId, eventId],
    queryFn: () =>
      apiGet(
        `/evaluations/orgs/${orgId}/events/${eventId}/registrants`,
        registrantsSchema,
      ),
    enabled: Boolean(orgId && eventId),
  });
  const evaluatorCandidates = useQuery({
    queryKey: ['evaluation-candidates', orgId],
    queryFn: () =>
      apiGet(
        `/evaluations/orgs/${orgId}/evaluator-candidates`,
        evaluatorCandidatesSchema,
      ),
    enabled: Boolean(orgId),
  });
  const programs = useQuery({
    queryKey: ['evaluation-programs', orgId],
    queryFn: () =>
      apiGet(`/evaluations/orgs/${orgId}/programs`, programsSchema),
    enabled: Boolean(orgId),
  });
  const results = useQuery({
    queryKey: ['evaluation-results', orgId, eventId],
    queryFn: () =>
      apiGet(
        `/evaluations/orgs/${orgId}/events/${eventId}/results`,
        resultsSchema,
      ),
    enabled: false,
  });
  const consistency = useQuery({
    queryKey: ['evaluation-consistency', orgId, eventId],
    queryFn: () =>
      apiGet(
        `/evaluations/orgs/${orgId}/events/${eventId}/consistency`,
        consistencySchema,
      ),
    enabled: showConsistency,
  });
  const board = useQuery({
    queryKey: ['evaluation-board', orgId, boardId],
    queryFn: () =>
      apiGet(`/evaluations/orgs/${orgId}/boards/${boardId}`, boardDetailSchema),
    enabled: Boolean(boardId),
  });
  const dashboard = useQuery({
    queryKey: ['evaluation-offers', orgId, boardId],
    queryFn: () =>
      apiGet(
        `/evaluations/orgs/${orgId}/boards/${boardId}/offers`,
        offerDashboardSchema,
      ),
    enabled: Boolean(boardId),
  });
  const [evaluationGroupId, setEvaluationGroupId] = useState('');
  const targetProgram = programs.data?.find(
    (program) => program.id === setup.data?.event.target_program_id,
  );
  const selectedOffering = targetProgram?.offerings.find(
    (offering) => offering.id === offerOfferingId,
  );
  const visibleParticipants = useMemo(
    () =>
      (setup.data?.participants ?? []).filter((participant) => {
        const query = checkInSearch.trim().toLowerCase();
        return (
          !query ||
          `${participant.firstName} ${participant.lastName} ${String(participant.bibNumber)} ${participant.registrationId}`
            .toLowerCase()
            .includes(query)
        );
      }),
    [checkInSearch, setup.data?.participants],
  );
  const session = useMutation({
    mutationFn: (groupId: string | null) =>
      apiPost(
        `/evaluations/orgs/${orgId}/events/${eventId}/sessions`,
        {
          name: sessionName,
          groupId,
          startsAt: new Date(sessionStart).toISOString(),
          endsAt: new Date(sessionEnd).toISOString(),
          timezone:
            Intl.DateTimeFormat().resolvedOptions().timeZone ||
            'America/Chicago',
          facilityId: null,
          capacity: null,
        },
        responseSchema,
      ),
    onSuccess: async () => {
      setNotice('Session saved.');
      await queryClient.invalidateQueries({
        queryKey: ['evaluation-setup', orgId, eventId],
      });
    },
    onError: (cause) => {
      setNotice(
        cause instanceof Error ? cause.message : 'Session could not be saved.',
      );
    },
  });
  const assignEvaluator = useMutation({
    mutationFn: () =>
      apiPost(
        `/evaluations/orgs/${orgId}/events/${eventId}/evaluators`,
        { sessionId: evaluatorSessionId, accountId: evaluatorAccountId },
        responseSchema,
      ),
    onSuccess: () => {
      setNotice('Evaluator assigned after the current compliance check.');
    },
    onError: (cause) => {
      setNotice(
        cause instanceof Error
          ? cause.message
          : 'Evaluator assignment failed the compliance check.',
      );
    },
  });
  const participant = useMutation({
    mutationFn: (registrant: { personId: string; registrationId: string }) =>
      apiPost(
        `/evaluations/orgs/${orgId}/events/${eventId}/participants`,
        {
          ...registrant,
          groupId: groupId || null,
          sessionId: sessionId || null,
          positionKeys: positionKeys
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean),
        },
        responseSchema,
      ),
    onSuccess: async () => {
      setRegistrationId('');
      setNotice('Registered athlete assigned a bib.');
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['evaluation-setup', orgId, eventId],
        }),
        queryClient.invalidateQueries({
          queryKey: ['evaluation-registrants', orgId, eventId],
        }),
      ]);
    },
    onError: (cause) => {
      setNotice(
        cause instanceof Error
          ? cause.message
          : 'Athlete could not be assigned.',
      );
    },
  });
  const checkIn = useMutation({
    mutationFn: (participantId: string) =>
      apiPost(
        `/evaluations/orgs/${orgId}/participants/${participantId}/check-in`,
        { late: false },
        responseSchema,
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['evaluation-setup', orgId, eventId],
      });
    },
  });
  const capturePhoto = useMutation({
    mutationFn: (input: {
      personId: string;
      personVersion: number;
      mediaConsent: boolean;
      file: File;
    }) => captureEvaluationParticipantPhoto({ orgId, ...input }),
    onSuccess: async (_, input) => {
      setParticipantPhotos((current) => ({
        ...current,
        [input.personId]: null,
      }));
      setPhotoInputVersion((current) => current + 1);
      setNotice('Consented athlete photo saved.');
      await queryClient.invalidateQueries({
        queryKey: ['evaluation-setup', orgId, eventId],
      });
    },
    onError: (cause) => {
      setNotice(
        cause instanceof Error ? cause.message : 'Photo could not be saved.',
      );
    },
  });
  const checkInRegistration = (value: string) => {
    const registration =
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
        .exec(value)?.[0]
        ?.toLowerCase();
    const participantRow = setup.data?.participants.find(
      (row) => row.registrationId.toLowerCase() === registration,
    );
    if (!participantRow) {
      setNotice(
        'That registration QR is not assigned to this evaluation. Assign the registered athlete first.',
      );
      return;
    }
    checkIn.mutate(participantRow.id);
    setRegistrationQr('');
  };
  const compute = useMutation({
    mutationFn: () =>
      apiPost(
        `/evaluations/orgs/${orgId}/events/${eventId}/compute-results`,
        {},
        z.array(z.looseObject({ participantId: z.string() })),
      ),
    onSuccess: async () => {
      await results.refetch();
      setNotice('Normalized results are ready.');
    },
    onError: (cause) => {
      setNotice(
        cause instanceof Error
          ? cause.message
          : 'Results could not be computed.',
      );
    },
  });
  const createBoard = useMutation({
    mutationFn: () =>
      apiPost(
        `/evaluations/orgs/${orgId}/events/${eventId}/boards`,
        {
          divisionId: divisionId || null,
          evaluationGroupId: evaluationGroupId || null,
          seed: Number(seed),
          siblingsTogether,
          returningStay,
          positionMinimums:
            minimumPosition && minimumPositionCount
              ? { [minimumPosition]: Number(minimumPositionCount) }
              : {},
        },
        boardSchema,
      ),
    onSuccess: async (value) => {
      setBoardId(value.id);
      await queryClient.invalidateQueries({
        queryKey: ['evaluation-board', orgId, value.id],
      });
      setNotice('Placement draft balanced.');
    },
    onError: (cause) => {
      setNotice(
        cause instanceof Error
          ? cause.message
          : 'Placement board could not be created.',
      );
    },
  });
  const publish = useMutation({
    mutationFn: () =>
      apiPost(
        `/evaluations/orgs/${orgId}/boards/${boardId}/publish`,
        {},
        responseSchema,
      ),
    onSuccess: async () => {
      await board.refetch();
      setNotice('Placement board published.');
    },
  });
  const move = useMutation({
    mutationFn: (placement: {
      personId: string;
      teamSeasonId: string;
      version: number;
    }) =>
      apiPost(
        `/evaluations/orgs/${orgId}/boards/${boardId}/placements/move`,
        {
          personId: placement.personId,
          teamSeasonId: placement.teamSeasonId,
          expectedVersion: placement.version,
        },
        responseSchema,
      ),
    onSuccess: async () => {
      await board.refetch();
      setNotice('Placement moved.');
    },
    onError: (cause) => {
      setNotice(
        cause instanceof Error
          ? cause.message
          : 'The placement could not be moved.',
      );
    },
  });
  const lock = useMutation({
    mutationFn: (personId: string) =>
      apiPost(
        `/evaluations/orgs/${orgId}/boards/${boardId}/placements/${personId}/lock`,
        { reason: 'Coach request' },
        responseSchema,
      ),
    onSuccess: async () => {
      await board.refetch();
      setNotice('Placement locked.');
    },
    onError: (cause) => {
      setNotice(
        cause instanceof Error
          ? cause.message
          : 'The placement could not be locked.',
      );
    },
  });
  const offer = useMutation({
    mutationFn: (placementId: string) =>
      apiPost(
        `/evaluations/orgs/${orgId}/placements/${placementId}/offers`,
        {
          offeringId: offerOfferingId,
          amountCents: selectedOffering?.priceCents ?? 0,
          depositCents: Number(offerDeposit),
          expiresAt: new Date(offerExpires).toISOString(),
          message: null,
        },
        responseSchema,
      ),
    onSuccess: async () => {
      setNotice('Offer recorded for the family.');
      await dashboard.refetch();
    },
    onError: (cause) => {
      setNotice(
        cause instanceof Error ? cause.message : 'Offer could not be created.',
      );
    },
  });
  const heading = setup.data?.event.name ?? 'Evaluation event';
  const sortedResults = useMemo(() => results.data ?? [], [results.data]);
  return (
    <OrgLayout
      orgId={orgId}
      title={heading}
      description="Schedule sessions, check in athletes, compute normalized results and balance the placement board."
    >
      {setup.isPending ? (
        <p role="status">Loading evaluation setup…</p>
      ) : setup.isError ? (
        <p role="alert">{setup.error.message}</p>
      ) : (
        <>
          <section className="evaluation-grid">
            <Card>
              <h2>Schedule a session</h2>
              <form
                className="evaluation-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  session.mutate(groupId || null);
                }}
              >
                <Field label="Group">
                  <Select
                    value={groupId}
                    onChange={(event) => {
                      setGroupId(event.target.value);
                      setSessionId('');
                    }}
                  >
                    <option value="">Auto-assign group</option>
                    {setup.data.groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Session name">
                  <Input
                    value={sessionName}
                    onChange={(event) => {
                      setSessionName(event.target.value);
                    }}
                  />
                </Field>
                <Field label="Starts">
                  <Input
                    type="datetime-local"
                    required
                    value={sessionStart}
                    onChange={(event) => {
                      setSessionStart(event.target.value);
                    }}
                  />
                </Field>
                <Field label="Ends">
                  <Input
                    type="datetime-local"
                    required
                    value={sessionEnd}
                    onChange={(event) => {
                      setSessionEnd(event.target.value);
                    }}
                  />
                </Field>
                <Button type="submit" disabled={session.isPending}>
                  Add session
                </Button>
              </form>
              <ul>
                {setup.data.sessions.map((item) => (
                  <li key={item.id}>
                    {item.name} · {new Date(item.startsAt).toLocaleString()}
                  </li>
                ))}
              </ul>
              <h3>Assign evaluator</h3>
              <form
                className="evaluation-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  assignEvaluator.mutate();
                }}
              >
                <Field label="Session for this evaluator" required>
                  <Select
                    required
                    value={evaluatorSessionId}
                    onChange={(event) => {
                      setEvaluatorSessionId(event.target.value);
                    }}
                  >
                    <option value="">Select a session</option>
                    {setup.data.sessions.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Evaluator" required>
                  <Select
                    required
                    value={evaluatorAccountId}
                    onChange={(event) => {
                      setEvaluatorAccountId(event.target.value);
                    }}
                  >
                    <option value="">Select an evaluator</option>
                    {(evaluatorCandidates.data ?? []).map((candidate) => (
                      <option
                        key={candidate.accountId}
                        value={candidate.accountId}
                      >
                        {candidate.firstName} {candidate.lastName}
                      </option>
                    ))}
                  </Select>
                </Field>
                {evaluatorCandidates.isError && (
                  <p role="alert">{evaluatorCandidates.error.message}</p>
                )}
                <Button
                  type="submit"
                  disabled={
                    assignEvaluator.isPending ||
                    !evaluatorSessionId ||
                    !evaluatorAccountId
                  }
                >
                  {assignEvaluator.isPending
                    ? 'Checking compliance…'
                    : 'Assign evaluator'}
                </Button>
              </form>
            </Card>
            <Card>
              <h2>Assign a registered athlete</h2>
              <p>
                Only confirmed tryout registrants can receive an evaluation bib.
                Age, competition gender and positions choose the group
                automatically.
              </p>
              <form
                className="evaluation-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const registrant = registrants.data?.find(
                    (row) =>
                      row.registrationId === registrationId && !row.assigned,
                  );
                  if (registrant) participant.mutate(registrant);
                }}
              >
                <Field label="Tryout registrant" required>
                  <Select
                    required
                    value={registrationId}
                    onChange={(event) => {
                      setRegistrationId(event.target.value);
                    }}
                  >
                    <option value="">Select a confirmed registrant</option>
                    {(registrants.data ?? [])
                      .filter((row) => !row.assigned)
                      .map((row) => (
                        <option
                          key={row.registrationId}
                          value={row.registrationId}
                        >
                          {row.firstName} {row.lastName}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="Group">
                  <Select
                    value={groupId}
                    onChange={(event) => {
                      setGroupId(event.target.value);
                      setSessionId('');
                    }}
                  >
                    <option value="">Auto-assign group</option>
                    {setup.data.groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Session">
                  <Select
                    value={sessionId}
                    onChange={(event) => {
                      setSessionId(event.target.value);
                    }}
                  >
                    <option value="">No session assigned</option>
                    {setup.data.sessions
                      .filter(
                        (sessionOption) =>
                          !sessionOption.groupId ||
                          !groupId ||
                          sessionOption.groupId === groupId,
                      )
                      .map((sessionOption) => (
                        <option key={sessionOption.id} value={sessionOption.id}>
                          {sessionOption.name}
                        </option>
                      ))}
                  </Select>
                </Field>
                <Field label="Positions">
                  <Input
                    value={positionKeys}
                    onChange={(event) => {
                      setPositionKeys(event.target.value);
                    }}
                    placeholder="Forward, midfield"
                  />
                </Field>
                {registrants.isError && (
                  <p role="alert">{registrants.error.message}</p>
                )}
                <Button
                  type="submit"
                  disabled={participant.isPending || !registrationId}
                >
                  {participant.isPending ? 'Assigning…' : 'Assign bib'}
                </Button>
              </form>
            </Card>
          </section>
          <Card className="evaluation-checkin">
            <div className="evaluation-card-heading">
              <div>
                <h2>Check-in and bib list</h2>
                <p>
                  Search by name or bib. A USB QR scanner can enter the
                  registration code from the confirmation email.
                </p>
              </div>
              <Button
                secondary
                type="button"
                onClick={() => {
                  window.print();
                }}
              >
                Print bib sheet
              </Button>
            </div>
            <div className="evaluation-checkin-tools">
              <Field label="Search bib list">
                <Input
                  type="search"
                  value={checkInSearch}
                  onChange={(event) => {
                    setCheckInSearch(event.target.value);
                  }}
                />
              </Field>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  checkInRegistration(registrationQr);
                }}
              >
                <Field label="Scan registration QR code">
                  <Input
                    autoComplete="off"
                    value={registrationQr}
                    onChange={(event) => {
                      setRegistrationQr(event.target.value);
                    }}
                  />
                </Field>
                <Button
                  type="submit"
                  disabled={!registrationQr.trim() || checkIn.isPending}
                >
                  Check in scanned registration
                </Button>
              </form>
            </div>
            {visibleParticipants.length ? (
              <div
                className="evaluation-table-wrap"
                role="region"
                aria-label="Participant check-in list"
                tabIndex={0}
              >
                <table>
                  <thead>
                    <tr>
                      <th>Bib</th>
                      <th>Athlete</th>
                      <th>Group</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleParticipants.map((row) => (
                      <tr key={row.id}>
                        <td>{row.bibNumber}</td>
                        <td>
                          {row.firstName} {row.lastName}
                        </td>
                        <td>{row.groupName}</td>
                        <td>{row.checkInStatus}</td>
                        <td>
                          <div className="evaluation-move-controls">
                            {row.checkInStatus === 'expected' ? (
                              <Button
                                type="button"
                                secondary
                                onClick={() => {
                                  checkIn.mutate(row.id);
                                }}
                              >
                                Check in
                              </Button>
                            ) : (
                              <Badge tone="ok">Checked in</Badge>
                            )}
                            {setup.data.canManagePhotos &&
                              (row.mediaConsent ? (
                                <>
                                  <Field
                                    label={`Capture photo for ${row.firstName} ${row.lastName}`}
                                  >
                                    <Input
                                      key={`${row.personId}-${String(photoInputVersion)}`}
                                      type="file"
                                      accept="image/jpeg,image/png,image/webp"
                                      capture="environment"
                                      disabled={capturePhoto.isPending}
                                      onChange={(event) => {
                                        setParticipantPhotos((current) => ({
                                          ...current,
                                          [row.personId]:
                                            event.target.files?.[0] ?? null,
                                        }));
                                      }}
                                    />
                                  </Field>
                                  {participantPhotos[row.personId] && (
                                    <Button
                                      type="button"
                                      disabled={capturePhoto.isPending}
                                      onClick={() => {
                                        const file =
                                          participantPhotos[row.personId];
                                        if (!file) return;
                                        capturePhoto.mutate({
                                          personId: row.personId,
                                          personVersion: row.personVersion,
                                          mediaConsent: row.mediaConsent,
                                          file,
                                        });
                                      }}
                                    >
                                      Save photo
                                    </Button>
                                  )}
                                </>
                              ) : (
                                <span>
                                  Photo withheld: media consent required.
                                </span>
                              ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p>No participants match this search.</p>
            )}
          </Card>
          <section className="evaluation-grid">
            <Card>
              <h2>Results</h2>
              <p>
                Scoring uses the shared evaluator normalization policy; athletes
                with fewer than two evaluators are flagged.
              </p>
              <Button
                onClick={() => {
                  compute.mutate();
                }}
                disabled={compute.isPending}
              >
                Compute normalized results
              </Button>
              {sortedResults.length > 0 && (
                <div
                  className="evaluation-table-wrap"
                  role="region"
                  aria-label="Evaluation rankings"
                  tabIndex={0}
                >
                  <table>
                    <thead>
                      <tr>
                        <th>Rank</th>
                        <th>Athlete</th>
                        <th>Group</th>
                        <th>Composite</th>
                        <th>Evaluators</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedResults.map((row) => (
                        <tr key={row.participantId}>
                          <td>{row.rankInGroup ?? '—'}</td>
                          <td>
                            {row.firstName} {row.lastName}
                          </td>
                          <td>{row.group}</td>
                          <td>{row.composite?.toFixed(2) ?? 'Incomplete'}</td>
                          <td>
                            {row.evaluatorCount}
                            {row.evaluatorCount < 2
                              ? ' · second evaluator needed'
                              : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {results.isError && <p role="alert">{results.error.message}</p>}
              <Button
                secondary
                type="button"
                onClick={() => {
                  setShowConsistency((current) => !current);
                }}
                aria-expanded={showConsistency}
              >
                Evaluator consistency
              </Button>
              {showConsistency &&
                (consistency.isPending ? (
                  <p role="status">Loading evaluator consistency…</p>
                ) : consistency.isError ? (
                  <p role="alert">{consistency.error.message}</p>
                ) : consistency.data.length ? (
                  <div
                    className="evaluation-table-wrap"
                    role="region"
                    aria-label="Evaluator consistency"
                    tabIndex={0}
                  >
                    <table>
                      <thead>
                        <tr>
                          <th>Evaluator</th>
                          <th>Criterion</th>
                          <th>Scores</th>
                          <th>Mean</th>
                          <th>Standard deviation</th>
                        </tr>
                      </thead>
                      <tbody>
                        {consistency.data.map((row) => (
                          <tr key={`${row.evaluatorId}-${row.criterionKey}`}>
                            <td>{row.evaluatorName || 'Evaluator'}</td>
                            <td>{row.criterionKey}</td>
                            <td>{row.scoreCount}</td>
                            <td>{row.mean.toFixed(2)}</td>
                            <td>{row.standard_deviation.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p>No scores yet.</p>
                ))}
              <Button
                secondary
                type="button"
                onClick={() =>
                  void downloadEvaluationCsv(orgId, eventId).catch(
                    (cause: unknown) => {
                      setNotice(
                        cause instanceof Error
                          ? cause.message
                          : 'Export unavailable.',
                      );
                    },
                  )
                }
              >
                Export results CSV
              </Button>
            </Card>
            <Card>
              <h2>Placement board</h2>
              <p>
                Teams are balanced with fixed coach-family placements and
                optional sibling grouping.
              </p>
              <Field label="Target division">
                <Select
                  value={divisionId}
                  onChange={(event) => {
                    setDivisionId(event.target.value);
                  }}
                >
                  <option value="">Select a division</option>
                  {(targetProgram?.divisions ?? []).map((division) => (
                    <option key={division.id} value={division.id}>
                      {division.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Evaluation group">
                <Select
                  value={evaluationGroupId}
                  onChange={(event) => {
                    setEvaluationGroupId(event.target.value);
                  }}
                >
                  <option value="">Match group name to division</option>
                  {setup.data.groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Deterministic seed">
                <Input
                  inputMode="numeric"
                  value={seed}
                  onChange={(event) => {
                    setSeed(event.target.value);
                  }}
                />
              </Field>
              <Field label="Keep siblings together">
                <Input
                  type="checkbox"
                  checked={siblingsTogether}
                  onChange={(event) => {
                    setSiblingsTogether(event.target.checked);
                  }}
                />
              </Field>
              <Field label="Keep returning players with their prior team">
                <Input
                  type="checkbox"
                  checked={returningStay}
                  onChange={(event) => {
                    setReturningStay(event.target.checked);
                  }}
                />
              </Field>
              <Field label="Minimum position to cover">
                <Input
                  value={minimumPosition}
                  onChange={(event) => {
                    setMinimumPosition(event.target.value);
                  }}
                  placeholder="keeper"
                />
              </Field>
              <Field label="Minimum players per team">
                <Input
                  type="number"
                  min="0"
                  max="30"
                  value={minimumPositionCount}
                  onChange={(event) => {
                    setMinimumPositionCount(event.target.value);
                  }}
                />
              </Field>
              <Button
                onClick={() => {
                  createBoard.mutate();
                }}
                disabled={createBoard.isPending || !divisionId}
              >
                Build placement draft
              </Button>
              {boardId && (
                <p>
                  Board <code>{boardId}</code>
                </p>
              )}
              {board.data?.status === 'draft' && (
                <p>
                  Drag a player onto a teammate to move them to that team, or
                  use the team selector and Move button with a keyboard.
                </p>
              )}
              {board.data?.placements.map((row) => (
                <div
                  className="evaluation-placement"
                  key={row.personId}
                  draggable={board.data.status === 'draft' && !row.locked}
                  onDragStart={(event) => {
                    draggedPlacementPerson.current = row.personId;
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', row.personId);
                  }}
                  onDragEnd={() => {
                    draggedPlacementPerson.current = null;
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const personId =
                      draggedPlacementPerson.current ||
                      event.dataTransfer.getData('text/plain');
                    draggedPlacementPerson.current = null;
                    const source = board.data.placements.find(
                      (placement) => placement.personId === personId,
                    );
                    if (
                      !source ||
                      source.locked ||
                      source.personId === row.personId ||
                      source.teamSeasonId === row.teamSeasonId
                    )
                      return;
                    move.mutate({
                      personId,
                      teamSeasonId: row.teamSeasonId,
                      version: source.version,
                    });
                  }}
                >
                  <span>
                    {row.firstName} {row.lastName} → {row.teamName}
                  </span>
                  <Badge tone={row.locked ? 'warn' : 'neutral'}>
                    {row.locked ? 'locked' : row.status}
                  </Badge>
                  {board.data.status === 'draft' && (
                    <div className="evaluation-move-controls">
                      <Select
                        aria-label={`Move ${row.firstName} ${row.lastName} to team`}
                        value={moveTargets[row.personId] ?? row.teamSeasonId}
                        onChange={(event) => {
                          setMoveTargets((current) => ({
                            ...current,
                            [row.personId]: event.target.value,
                          }));
                        }}
                      >
                        {(dashboard.data?.teams ?? []).map((team) => (
                          <option
                            key={team.teamSeasonId}
                            value={team.teamSeasonId}
                          >
                            {team.teamName}
                          </option>
                        ))}
                      </Select>
                      <Button
                        secondary
                        type="button"
                        disabled={
                          move.isPending ||
                          (moveTargets[row.personId] ?? row.teamSeasonId) ===
                            row.teamSeasonId
                        }
                        onClick={() => {
                          const target =
                            moveTargets[row.personId] ?? row.teamSeasonId;
                          move.mutate({
                            personId: row.personId,
                            teamSeasonId: target,
                            version: row.version,
                          });
                        }}
                      >
                        Move
                      </Button>
                      <Button
                        secondary
                        type="button"
                        disabled={row.locked || lock.isPending}
                        onClick={() => {
                          lock.mutate(row.personId);
                        }}
                      >
                        Lock
                      </Button>
                    </div>
                  )}
                  {board.data.status === 'published' &&
                    row.status === 'published' && (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          offer.mutate(row.id);
                        }}
                        className="evaluation-offer-form"
                      >
                        <Select
                          aria-label="Registration offering"
                          value={offerOfferingId}
                          onChange={(event) => {
                            setOfferOfferingId(event.target.value);
                          }}
                          required
                        >
                          <option value="">Select registration offering</option>
                          {(targetProgram?.offerings ?? []).map(
                            (offeringOption) => (
                              <option
                                key={offeringOption.id}
                                value={offeringOption.id}
                              >
                                {offeringOption.name} · $
                                {(offeringOption.priceCents / 100).toFixed(2)}
                              </option>
                            ),
                          )}
                        </Select>
                        <p>
                          Offer amount:{' '}
                          {selectedOffering
                            ? `$${(selectedOffering.priceCents / 100).toFixed(2)}`
                            : 'Select an offering'}
                        </p>
                        <Input
                          aria-label="Offer deposit in cents"
                          inputMode="numeric"
                          placeholder="Deposit cents"
                          value={offerDeposit}
                          onChange={(event) => {
                            setOfferDeposit(event.target.value);
                          }}
                          required
                        />
                        <Input
                          aria-label="Offer expiry"
                          type="datetime-local"
                          value={offerExpires}
                          onChange={(event) => {
                            setOfferExpires(event.target.value);
                          }}
                          required
                        />
                        <Button
                          type="submit"
                          disabled={
                            offer.isPending ||
                            !selectedOffering ||
                            !offerDeposit ||
                            Number(offerDeposit) > selectedOffering.priceCents
                          }
                        >
                          Create offer
                        </Button>
                      </form>
                    )}
                </div>
              ))}
              {board.data && (
                <Button
                  secondary
                  onClick={() => {
                    publish.mutate();
                  }}
                  disabled={board.data.status !== 'draft'}
                >
                  Publish placements
                </Button>
              )}
            </Card>
          </section>
          {dashboard.data && (
            <Card>
              <h2>Offer status and next in line</h2>
              <div
                className="evaluation-table-wrap"
                role="region"
                aria-label="Team offer status"
                tabIndex={0}
              >
                <table>
                  <thead>
                    <tr>
                      <th>Team</th>
                      <th>Roster</th>
                      <th>Sent</th>
                      <th>Accepted</th>
                      <th>Declined</th>
                      <th>Expired</th>
                      <th>Withdrawn</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.data.teams.map((team) => (
                      <tr key={team.teamSeasonId}>
                        <td>{team.teamName}</td>
                        <td>
                          {team.placed}
                          {team.rosterLimit
                            ? ` / ${String(team.rosterLimit)}`
                            : ''}
                        </td>
                        <td>{team.sent}</td>
                        <td>{team.accepted}</td>
                        <td>{team.declined}</td>
                        <td>{team.expired}</td>
                        <td>{team.withdrawn}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {dashboard.data.nextInLine.length > 0 && (
                <>
                  <h3>Next in line</h3>
                  <ol className="evaluation-next-in-line">
                    {dashboard.data.nextInLine.map((row) => (
                      <li key={row.personId}>
                        {row.firstName} {row.lastName} · {row.group}
                        {row.composite === null
                          ? ''
                          : ` · ${row.composite.toFixed(2)}`}
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </Card>
          )}
          {notice && (
            <p role="status" className="evaluation-notice">
              {notice}
            </p>
          )}
        </>
      )}
    </OrgLayout>
  );
}
