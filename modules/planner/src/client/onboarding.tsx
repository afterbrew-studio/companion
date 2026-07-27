import { defineOnboarding, OnboardingArt } from '@moxxy-ai/companion-sdk/client';

function IdeasArt(): JSX.Element {
  return (
    <OnboardingArt>
      <g fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M31 30h31v30H31zM69 24h20v17H69zM69 48h20v17H69z" />
        <path d="M39 39h15M39 47h11M62 44h7M79 41v7M79 53v7" />
      </g>
    </OnboardingArt>
  );
}

export const onboarding = defineOnboarding([{
  key: 'ideas',
  order: 25,
  permission: 'planner:read',
  title: 'Ideas: from outcome to active work',
  body: 'Describe what you want in plain language. Ideas asks only critical decisions, creates the planning artifacts, prepares tasks and shows Board automation before work starts.',
  chips: ['Guided questions', 'Reviewable drafts', 'One final launch'],
  art: () => <IdeasArt />,
  cta: { label: 'Plan a feature', href: '#/ideas' },
}]);
