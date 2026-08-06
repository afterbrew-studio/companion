import { defineOnboarding, OnboardingArt } from '@moxxy/companion-core/client';

function RunnersArt({ playing }: { playing: boolean }): JSX.Element {
  return (
    <OnboardingArt>
      <g stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="30" y="24" width="60" height="16" rx="3" />
        <rect x="30" y="48" width="60" height="16" rx="3" />
        <circle className={playing ? 'ob-blink' : ''} cx="38" cy="32" r="2.2" fill="currentColor" stroke="none" />
        <circle className={playing ? 'ob-blink ob-blink-2' : ''} cx="38" cy="56" r="2.2" fill="currentColor" stroke="none" />
        <path d="M48 32h32M48 56h32" opacity="0.5" />
      </g>
    </OnboardingArt>
  );
}

/** module-operate's slice of the welcome tour (scaling runs across machines). */
export const onboarding = defineOnboarding([
  {
    key: 'runners',
    order: 60,
    permission: 'runners:connect',
    title: 'Scale across machines',
    body: 'Agent work uses the shared runner pool by default, so most people need no setup. Attach a private machine from Settings only when you need your own runtime or models.',
    chips: ['Agents → Agent Runs', 'Settings → Runners'],
    art: (playing) => <RunnersArt playing={playing} />,
  },
]);
