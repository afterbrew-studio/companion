import { defineOnboarding, OnboardingArt } from '@moxxy-ai/companion-sdk/client';

function CodeArt({ playing }: { playing: boolean }): JSX.Element {
  return (
    <OnboardingArt>
      <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="34" cy="30" r="5" />
        <circle cx="34" cy="62" r="5" />
        <circle cx="84" cy="62" r="5" />
        <path d="M34 35v22M60 30h14a4 4 0 0 1 4 4v23" />
        <path className={playing ? 'ob-check' : ''} d="M50 46l6 6 12-13" stroke="currentColor" strokeWidth="2.6" />
      </g>
    </OnboardingArt>
  );
}

/** module-code's slice of the welcome tour (issues / PRs / pipelines). */
export const onboarding = defineOnboarding([
  {
    key: 'code',
    order: 40,
    permission: 'prs:read',
    title: 'Code: issues, PRs & pipelines',
    body: 'Triage issues, review pull requests with CI context, and let agents fix failing checks or address review feedback right on the branch. Compose pipelines from typed steps to automate it all.',
    chips: ['Issues', 'Pull Requests', 'Pipelines'],
    art: (playing) => <CodeArt playing={playing} />,
  },
]);
