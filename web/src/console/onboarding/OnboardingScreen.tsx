import { Link, PageHeader } from '../../ui/primitives';

import { OnboardingChecklist } from './OnboardingChecklist';

import '../home.css';
import './onboarding.css';

export function OnboardingScreen({
  orgId,
}: {
  orgId: string;
}): React.JSX.Element {
  return (
    <main className="console-home">
      <PageHeader
        title="Organization setup"
        kicker="GETTING STARTED"
        description="Follow the steps to get your organization ready. Progress saves automatically, and you can restore any step you dismiss."
      />
      <OnboardingChecklist orgId={orgId} />
      <p className="onboarding-help">
        Need a hand?{' '}
        <Link to={`/console/orgs/${orgId}/help`}>Browse the help center</Link>{' '}
        for setup guides or to contact support.
      </p>
    </main>
  );
}
