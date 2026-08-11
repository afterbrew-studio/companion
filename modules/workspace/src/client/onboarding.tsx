import { defineOnboarding, OnboardingArt } from '@moxxy/companion-sdk/client';

/** A workspace folder gathering three repo tiles that settle in. */
function WorkspaceArt({ playing }: { playing: boolean }): React.JSX.Element {
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

/** module-workspace's slice of the welcome tour. Two variants of one step, split
 *  on the module's own permission: admins get the setup copy, everyone else a
 *  read-only version, so no role loses the step. */
export const onboarding = defineOnboarding([
  {
    key: 'workspaces',
    order: 10,
    permission: 'workspaces:manage',
    title: 'Start with a workspace',
    body: 'A workspace groups related repositories. Create one from New, then switch context from the top of the sidebar; every page follows that choice.',
    chips: ['New → Create workspace', 'Sidebar → Workspace'],
    art: (playing) => <WorkspaceArt playing={playing} />,
  },
  {
    key: 'workspaces-maintainer',
    order: 10,
    withoutPermission: 'workspaces:manage',
    title: 'Start with a workspace',
    body: 'A workspace groups related repositories. An admin creates and manages them; you pick your active one from the top of the sidebar, and every page follows that choice.',
    chips: ['Sidebar → Workspace'],
    art: (playing) => <WorkspaceArt playing={playing} />,
  },
]);
