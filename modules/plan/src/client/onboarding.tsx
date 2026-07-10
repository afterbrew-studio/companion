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

/** module-plan's slice of the welcome tour (proposals / specs / docs). */
export const onboarding = defineOnboarding([
  {
    key: 'plan',
    order: 30,
    need: 'proposals:read',
    title: 'Plan: proposals, specs & docs',
    body: 'Describe a change in plain language — an agent assesses feasibility, then implements it into a PR. Specifications ground that work in how your code should behave; documentation is indexed so every agent knows your project.',
    chips: ['Proposals', 'Specifications', 'Documentation'],
    art: (playing) => <PlanArt playing={playing} />,
    cta: { label: 'Write a proposal', href: '#/proposals' },
  },
]);
