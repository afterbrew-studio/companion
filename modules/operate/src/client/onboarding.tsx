import { defineOnboarding, OnboardingArt } from '@moxxy/companion-core/client';

function RunnersArt({ playing }: { playing: boolean }): React.JSX.Element {
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

/** module-operate's slice of the welcome tour (where agent work executes). */
export const onboarding = defineOnboarding([
  {
    key: 'runners',
    order: 60,
    permission: 'runners:connect',
    title: 'Give agents a machine to run on',
    body: 'Agent runs need somewhere to execute: a runtime CLI installed on the machine hosting Companion, or another machine you attach as a runner. The Runners page shows what this instance has and is where you add capacity.',
    chips: ['Settings → Runners'],
    art: (playing) => <RunnersArt playing={playing} />,
  },
]);
