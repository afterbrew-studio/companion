import { defineOnboarding, OnboardingArt } from '@moxxy/companion-sdk/client';

function PlanArt({ playing }: { playing: boolean }): React.JSX.Element {
  return (
    <OnboardingArt>
      <g stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="30" y="22" width="34" height="46" rx="4" />
        <path d="M37 34h20M37 42h20M37 50h12" className={playing ? 'ob-write' : ''} />
        <path d="M72 30l14 4-4 14-14-4z" className={playing ? 'ob-float' : ''} />
        <path d="M75 36l8 2" />
      </g>
    </OnboardingArt>
  );
}

/** module-plan's slice of the welcome tour (the reusable knowledge artifacts). */
export const onboarding = defineOnboarding([
  {
    key: 'plan',
    order: 30,
    permission: 'specs:read',
    title: 'Plan and build from an outcome',
    body: 'Describe a feature as an outcome, keep lasting behavior in Specifications, and give agents shared context in Documentation. Each surface starts with one clear next step.',
    chips: ['Feature planning', 'Specifications', 'Documentation', 'Task Board'],
    art: (playing) => <PlanArt playing={playing} />,
    cta: { label: 'Browse specifications', href: '#/specs' },
  },
]);
