import { defineOnboarding, OnboardingArt } from '@companion/core/client';

function PlanArt({ playing }: { playing: boolean }): JSX.Element {
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
    need: 'specs:read',
    title: 'Plan: specifications & documentation',
    body: 'Specifications describe how your code should behave, while documentation gives every agent the product and system context it needs.',
    chips: ['Specifications', 'Documentation'],
    art: (playing) => <PlanArt playing={playing} />,
    cta: { label: 'Browse specifications', href: '#/specs' },
  },
]);
