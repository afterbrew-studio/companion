import { RequiresRepo } from '@companion/module-code/client';
import { defineClientRoutes, lazyView, type RouteProps } from '@moxxy/companion-sdk/client';

const AutomationsRoute = lazyView(async () => {
  const { AutomationsPage } = await import('./pages/Automations.js');
  const Gated = (_props: RouteProps): JSX.Element => (
    <RequiresRepo what="Automations"><AutomationsPage /></RequiresRepo>
  );
  return { default: Gated };
});

const RepositoryAutomationsRoute = lazyView(async () => {
  const { RepositoryAutomationsPage } = await import('./pages/Automations.js');
  const Gated = ({ params }: RouteProps): JSX.Element => (
    <RequiresRepo what="Repository automations">
      <RepositoryAutomationsPage key={params.repo} repo={params.repo!} />
    </RequiresRepo>
  );
  return { default: Gated };
});

const DigestRoute = lazyView(async () => {
  const { DigestPage } = await import('./pages/Digest.js');
  const Gated = (_props: RouteProps): JSX.Element => (
    <RequiresRepo what="Daily Digest"><DigestPage /></RequiresRepo>
  );
  return { default: Gated };
});

// The digest-in-the-making loader view of a report run (regex outranks the
// /digest prefix on specificity, so ordering here doesn't matter).
const DigestLiveRoute = lazyView(async () => {
  const { DigestLivePage } = await import('./pages/DigestLive.js');
  const Wrapped = ({ params }: RouteProps): JSX.Element => (
    <RequiresRepo what="Daily Digest">
      <DigestLivePage key={params.repo} repo={params.repo!} />
    </RequiresRepo>
  );
  return { default: Wrapped };
});

export const routes = defineClientRoutes([
  {
    match: { exact: '/repos/automation-health' },
    permission: 'automations:manage',
    component: AutomationsRoute,
  },
  {
    match: {
      regex: /^\/repos\/([\w.-]+)\/([\w.-]+)\/automations$/,
      params: (m) => ({ repo: `${m[1]}/${m[2]}` }),
    },
    permission: 'automations:manage',
    component: RepositoryAutomationsRoute,
  },
  {
    // Compatibility for saved notifications and bookmarks from before
    // automation configuration moved under the repository hub.
    match: { prefix: '/automations' },
    permission: 'automations:manage',
    component: AutomationsRoute,
  },
  {
    match: { regex: /^\/digest\/([\w.-]+)\/([\w.-]+)\/live$/, params: (m) => ({ repo: `${m[1]}/${m[2]}` }) },
    permission: 'reports:read',
    component: DigestLiveRoute,
  },
  // The digest surface is automations-owned (it generates the digests); its
  // entry lives in shared Home and gates on reports:read.
  {
    match: { prefix: '/digest' },
    permission: 'reports:read',
    component: DigestRoute,
  },
]);
