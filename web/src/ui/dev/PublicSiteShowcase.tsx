import { PublicSiteShell } from '../PublicSiteShell';

const publicNavigation = [
  { label: 'Home', to: '/__ui?surface=public#home', current: true },
  { label: 'Leagues', to: '/__ui?surface=public#leagues' },
  { label: 'Tournaments', to: '/__ui?surface=public#tournaments' },
  { label: 'Events', to: '/__ui?surface=public#events' },
  { label: 'Club Teams', to: '/__ui?surface=public#club-teams' },
  { label: 'Camps', to: '/__ui?surface=public#camps' },
  { label: 'Classes', to: '/__ui?surface=public#classes' },
  { label: 'Calendar', to: '/__ui?surface=public#calendar' },
  { label: 'Locations', to: '/__ui?surface=public#locations' },
  { label: 'Store', to: '/__ui?surface=public#store' },
];

const sampleSections = [
  { id: 'leagues', title: 'Leagues' },
  { id: 'tournaments', title: 'Tournaments' },
  { id: 'events', title: 'Events' },
  { id: 'club-teams', title: 'Club Teams' },
  { id: 'camps', title: 'Camps' },
  { id: 'classes', title: 'Classes' },
  { id: 'calendar', title: 'Calendar' },
  { id: 'locations', title: 'Locations' },
  { id: 'store', title: 'Store' },
];

export function PublicSiteShowcase(): React.JSX.Element {
  return (
    <PublicSiteShell
      administratorLink={{ label: 'Administrator sign in', to: '/' }}
      footerCredit="Powered by Athlentry"
      footerLinks={[
        { label: 'Terms', to: '/__ui?surface=public#terms' },
        { label: 'Privacy', to: '/__ui?surface=public#privacy' },
      ]}
      homeTo="/__ui?surface=public#home"
      memberLink={{ label: 'Member sign in', to: '/me' }}
      navigation={publicNavigation}
      organizationName="Northstar Youth Sports"
    >
      <div id="home">
        <h1>Northstar Youth Sports</h1>
        <h2>Find your next season.</h2>
        <p>Explore programs, schedules, and opportunities to play.</p>
      </div>
      {sampleSections.map((section) => (
        <section key={section.id} id={section.id}>
          <h2>{section.title}</h2>
        </section>
      ))}
      <section id="terms">
        <h2>Terms</h2>
      </section>
      <section id="privacy">
        <h2>Privacy</h2>
      </section>
    </PublicSiteShell>
  );
}
