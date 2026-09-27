import { PageHeader } from '../../ui/primitives';

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
        description="Complete or dismiss each setup step. Progress is saved for your organization."
      />
      <OnboardingChecklist orgId={orgId} />
    </main>
  );
}
