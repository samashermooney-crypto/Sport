import {
  websitePublicTeamSchema,
  websitePublicTeamsSchema,
} from '@shared/schemas/website';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { apiGet } from '../api/client';

import '../console/schedule/schedule.css';

export function PublicTeamsPage(): React.JSX.Element {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { t } = useTranslation('site');
  const result = useQuery({
    queryKey: ['public-site-teams', orgSlug],
    queryFn: () =>
      apiGet(
        `/website/public/${encodeURIComponent(String(orgSlug))}/teams`,
        websitePublicTeamsSchema,
      ),
    enabled: Boolean(orgSlug),
  });

  if (result.isPending)
    return (
      <main className="schedule-page" role="status" aria-busy="true">
        <p>{t('loadingTeams')}</p>
      </main>
    );
  if (result.isError)
    return (
      <main className="schedule-page">
        <p role="alert">{t('teamsUnavailableDescription')}</p>
      </main>
    );

  return (
    <main className="schedule-page">
      <header className="schedule-page__header">
        <div>
          <p className="schedule-page__eyebrow">{t('teamsEyebrow')}</p>
          <h1>{t('teamsTitle')}</h1>
          <p>{result.data.organization.name}</p>
        </div>
      </header>
      <section className="schedule-card" aria-labelledby="public-teams">
        <h2 id="public-teams">{t('teamsHeading')}</h2>
        {result.data.teams.length ? (
          <ul className="schedule-run-list">
            {result.data.teams.map((team) => (
              <li className="schedule-run" key={team.id}>
                <div>
                  <Link
                    to={`/site/${result.data.organization.slug}/teams/${encodeURIComponent(team.id)}`}
                  >
                    <strong>{team.name}</strong>
                  </Link>
                  <p>
                    {team.programName} · {team.divisionName}
                    {team.ageLabel ? ` · ${team.ageLabel}` : ''}
                  </p>
                  <p>{team.seasonName}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p>{t('teamsEmpty')}</p>
        )}
      </section>
    </main>
  );
}

export function PublicTeamPage(): React.JSX.Element {
  const { orgSlug, teamSeasonId } = useParams<{
    orgSlug: string;
    teamSeasonId: string;
  }>();
  const { t } = useTranslation('site');
  const result = useQuery({
    queryKey: ['public-site-team', orgSlug, teamSeasonId],
    queryFn: () =>
      apiGet(
        `/website/public/${encodeURIComponent(String(orgSlug))}/teams/${encodeURIComponent(String(teamSeasonId))}`,
        websitePublicTeamSchema,
      ),
    enabled: Boolean(orgSlug && teamSeasonId),
  });

  if (result.isPending)
    return (
      <main className="schedule-page" role="status" aria-busy="true">
        <p>{t('loadingTeams')}</p>
      </main>
    );
  if (result.isError)
    return (
      <main className="schedule-page">
        <h1>{t('teamUnavailable')}</h1>
        <p role="alert">{t('teamUnavailableDescription')}</p>
      </main>
    );

  const { organization, team } = result.data;
  return (
    <main className="schedule-page">
      <header className="schedule-page__header">
        <div>
          <p className="schedule-page__eyebrow">{t('teamsEyebrow')}</p>
          <h1>{team.name}</h1>
          <p>{organization.name}</p>
        </div>
      </header>
      <section className="schedule-card" aria-labelledby="team-details">
        <h2 id="team-details">{t('teamDetails')}</h2>
        <dl>
          <dt>{t('teamProgram')}</dt>
          <dd>{team.programName}</dd>
          <dt>{t('teamDivision')}</dt>
          <dd>
            {team.divisionName}
            {team.ageLabel ? ` · ${team.ageLabel}` : ''}
          </dd>
          <dt>{t('teamSeason')}</dt>
          <dd>{team.seasonName}</dd>
        </dl>
        <p>
          <Link to={`/site/${organization.slug}/teams`}>{t('allTeams')}</Link>
        </p>
      </section>
    </main>
  );
}
