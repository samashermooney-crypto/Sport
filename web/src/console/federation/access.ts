import type { FederationCapabilities } from '@shared/schemas/federation';

export type FederationBootstrapKey =
  | 'relationships'
  | 'programs'
  | 'members'
  | 'entries'
  | 'submissions'
  | 'teams'
  | 'spaces'
  | 'hostedGames'
  | 'contributions'
  | 'referees'
  | 'assignments'
  | 'fees'
  | 'payers'
  | 'discipline'
  | 'memberDiscipline'
  | 'scheduleRuns'
  | 'overview';

type FederationBootstrapResource = {
  key: FederationBootstrapKey;
  endpoint: string;
  capability: keyof FederationCapabilities;
};

/** Keep each console bootstrap request aligned with its API capability. */
export const federationBootstrapResources = [
  {
    key: 'relationships',
    endpoint: 'relationships',
    capability: 'relationships',
  },
  { key: 'programs', endpoint: 'programs', capability: 'directory' },
  { key: 'members', endpoint: 'members', capability: 'directory' },
  { key: 'entries', endpoint: 'entries', capability: 'directory' },
  {
    key: 'submissions',
    endpoint: 'submitted-entries',
    capability: 'submitEntries',
  },
  { key: 'teams', endpoint: 'my-teams', capability: 'submitEntries' },
  { key: 'spaces', endpoint: 'my-spaces', capability: 'submitEntries' },
  { key: 'hostedGames', endpoint: 'hosted-games', capability: 'submitEntries' },
  {
    key: 'contributions',
    endpoint: 'space-contributions',
    capability: 'submitEntries',
  },
  { key: 'referees', endpoint: 'referees', capability: 'referees' },
  {
    key: 'assignments',
    endpoint: 'referee-assignments',
    capability: 'referees',
  },
  { key: 'fees', endpoint: 'fees', capability: 'finance' },
  { key: 'payers', endpoint: 'member-payers', capability: 'finance' },
  {
    key: 'discipline',
    endpoint: 'federation-discipline',
    capability: 'discipline',
  },
  {
    key: 'memberDiscipline',
    endpoint: 'member-discipline',
    capability: 'directory',
  },
  { key: 'scheduleRuns', endpoint: 'schedule-runs', capability: 'schedule' },
  { key: 'overview', endpoint: 'dashboard', capability: 'directory' },
] as const satisfies readonly FederationBootstrapResource[];
