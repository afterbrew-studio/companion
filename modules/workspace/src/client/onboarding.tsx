import { defineOnboarding, OnboardingArt } from '@moxxy-ai/companion-sdk/client';

/** A workspace folder gathering three repo tiles that settle in. */
function WorkspaceArt({ playing }: { playing: boolean }): JSX.Element {
  return (
    <OnboardingArt>
      <g stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M26 34h14l4-6h30a4 4 0 0 1 4 4v30a4 4 0 0 1-4 4H26a4 4 0 0 1-4-4V38a4 4 0 0 1 4-4z" />
        <rect className={playing ? 'ob-tile' : ''} x="34" y="42" width="12" height="10" rx="2" />
        <rect className={playing ? 'ob-tile ob-tile-2' : ''} x="54" y="42" width="12" height="10" rx="2" />
        <rect className={playing ? 'ob-tile ob-tile-3' : ''} x="44" y="56" width="12" height="10" rx="2" />
      </g>
    </OnboardingArt>
  );
}

/** module-workspace's slice of the welcome tour. Gated on its own permission —
 *  no cross-module cast, the step simply never shows to a role that lacks it. */
export const onboarding = defineOnboarding([
  {
    key: 'workspaces',
    order: 10,
    permission: 'workspaces:manage',
    title: 'Start with a workspace',
    body: 'Workspaces group related repositories — Ideas, Issues, and Pull Requests are all scoped to the one you have active. Create and switch workspaces from the switcher at the top of the sidebar, or press ⌘K and search “Create workspace”.',
    chips: ['Sidebar → Workspace', '⌘K → Create workspace'],
    art: (playing) => <WorkspaceArt playing={playing} />,
  },
]);
