import { useTranslation } from 'react-i18next';

import { PublicSiteShell } from '../PublicSiteShell';

export function PublicSiteShowcase(): React.JSX.Element {
  const { t } = useTranslation('public');
  const publicNavigation = [
    { label: t('home'), to: '/__ui?surface=public#home', current: true },
    { label: t('leagues'), to: '/__ui?surface=public#leagues' },
    { label: t('tournaments'), to: '/__ui?surface=public#tournaments' },
    { label: t('events'), to: '/__ui?surface=public#events' },
    { label: t('clubTeams'), to: '/__ui?surface=public#club-teams' },
    { label: t('camps'), to: '/__ui?surface=public#camps' },
    { label: t('classes'), to: '/__ui?surface=public#classes' },
    { label: t('calendar'), to: '/__ui?surface=public#calendar' },
    { label: t('locations'), to: '/__ui?surface=public#locations' },
    { label: t('store'), to: '/__ui?surface=public#store' },
  ];

  const sampleSections = [
    { id: 'leagues', title: t('leagues') },
    { id: 'tournaments', title: t('tournaments') },
    { id: 'events', title: t('events') },
    { id: 'club-teams', title: t('clubTeams') },
    { id: 'camps', title: t('camps') },
    { id: 'classes', title: t('classes') },
    { id: 'calendar', title: t('calendar') },
    { id: 'locations', title: t('locations') },
    { id: 'store', title: t('store') },
  ];

  return (
    <PublicSiteShell
      administratorLink={{ label: t('administratorSignIn'), to: '/' }}
      footerLinks={[
        { label: t('terms'), to: '/__ui?surface=public#terms' },
        { label: t('privacy'), to: '/__ui?surface=public#privacy' },
      ]}
      homeTo="/__ui?surface=public#home"
      memberLink={{ label: t('memberSignIn'), to: '/me' }}
      navigation={publicNavigation}
      organizationName="Northstar Youth Sports"
    >
      <div id="home">
        <h1>Northstar Youth Sports</h1>
        <h2>{t('heroHeadline')}</h2>
        <p>{t('heroDescription')}</p>
      </div>
      {sampleSections.map((section) => (
        <section key={section.id} id={section.id}>
          <h2>{section.title}</h2>
        </section>
      ))}
      <section id="terms">
        <h2>{t('terms')}</h2>
      </section>
      <section id="privacy">
        <h2>{t('privacy')}</h2>
      </section>
    </PublicSiteShell>
  );
}
