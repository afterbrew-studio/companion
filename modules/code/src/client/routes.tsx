import type { ComponentType } from 'react';
import { defineClientRoutes, page, lazyView, type RouteProps } from '@moxxy/companion-sdk/client';

/**
 * Wrap a lazily-loaded page in the prerequisite gate.
 *
 * Applied at the route rather than inside each page: the rule is the same for
 * every GitHub-facing screen, and putting it here means a page added later
 * cannot forget it. The chunk still loads lazily; the gate renders around it.
 */
const gated = (load: () => Promise<{ default: ComponentType<RouteProps> }>, what: string) =>
  lazyView(async () => {
    const [{ default: Inner }, { RequiresRepo }] = await Promise.all([load(), import('./components/SetupGate.js')]);
    const Wrapped = (props: RouteProps): JSX.Element => (
      <RequiresRepo what={what}>
        <Inner {...props} />
      </RequiresRepo>
    );
    return { default: Wrapped };
  });

// Detail pages take typed props; wrap them so RouteProps params feed through
// with the legacy key-remount semantics (switching targets remounts the page).
const IssueDetailRoute = gated(async () => {
  const { IssueDetail } = await import('./pages/IssueDetail.js');
  const Wrapped = ({ params }: RouteProps): JSX.Element => (
    <IssueDetail key={`${params.repo}#${params.number}`} repo={params.repo!} number={Number(params.number)} />
  );
  return { default: Wrapped };
}, 'Issues');
const PrViewRoute = gated(async () => {
  const { PrView } = await import('./pages/pr/PrView.js');
  const Wrapped = ({ params }: RouteProps): JSX.Element => (
    <PrView key={`${params.repo}#${params.number}#${params.mode ?? ''}`} repo={params.repo!} number={Number(params.number)} mode={params.mode === 'review' ? 'review' : undefined} />
  );
  return { default: Wrapped };
}, 'Pull requests');
const PrBuildRoute = gated(async () => {
  const { PrBuild } = await import('./pages/pr/PrBuild.js');
  const Wrapped = ({ params }: RouteProps): JSX.Element => <PrBuild key={params.runId} runId={params.runId!} />;
  return { default: Wrapped };
}, 'Pull requests');

export const routes = defineClientRoutes([
  {
    match: { prefix: '/agent-quality' },
    permission: 'repos:read',
    component: page(() => import('./pages/AgentQuality.js').then((m) => m.AgentQualityPage)),
  },
  // The PR-in-the-making outcome view of a fix/implement run.
  {
    match: {
      regex: /^\/runs\/([A-Za-z0-9_-]+)\/preview$/,
      params: (m) => ({ runId: m[1]! }),
    },
    permission: 'runs:read',
    component: PrBuildRoute,
  },
  {
    match: {
      regex: /^\/repos\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)$/,
      params: (m) => ({ repo: `${m[1]}/${m[2]}`, number: m[3]! }),
    },
    permission: 'issues:read',
    component: IssueDetailRoute,
  },
  {
    match: {
      regex: /^\/repos\/([\w.-]+)\/([\w.-]+)\/prs\/(\d+)\/review$/,
      params: (m) => ({ repo: `${m[1]}/${m[2]}`, number: m[3]!, mode: 'review' }),
    },
    permission: 'prs:read',
    component: PrViewRoute,
  },
  {
    match: {
      regex: /^\/repos\/([\w.-]+)\/([\w.-]+)\/prs\/(\d+)$/,
      params: (m) => ({ repo: `${m[1]}/${m[2]}`, number: m[3]! }),
    },
    permission: 'prs:read',
    component: PrViewRoute,
  },
  {
    match: { prefix: '/issues' },
    permission: 'issues:read',
    component: gated(() => import('./pages/IssuesArea.js').then((m) => ({ default: m.IssuesAreaPage })), 'Issues'),
  },
  {
    match: { prefix: '/prs' },
    permission: 'prs:read',
    component: gated(() => import('./pages/PrsArea.js').then((m) => ({ default: m.PrsAreaPage })), 'Pull requests'),
  },
  {
    match: { prefix: '/pipelines' },
    permission: 'pipelines:read',
    component: gated(() => import('./pages/Pipelines.js').then((m) => ({ default: m.PipelinesPage })), 'Pipelines'),
  },
  {
    match: { prefix: '/repos' },
    permission: 'repos:manage',
    component: lazyView(async () => {
      const [{ ReposPage }, { RequiresGithubAccount }] = await Promise.all([
        import('./pages/ReposPage.js'),
        import('./components/SetupGate.js'),
      ]);
      // Only the account half: this page is where a repository gets added, so
      // gating it on having one would send you here from here.
      const Wrapped = (): JSX.Element => (
        <RequiresGithubAccount what="Connecting a repository">
          <ReposPage />
        </RequiresGithubAccount>
      );
      return { default: Wrapped };
    }),
  },
  {
    match: { prefix: '/github' },
    permission: 'github:connect',
    component: page(() => import('./pages/GithubAccounts.js').then((m) => m.GithubAccountsPage)),
  },
  // The workspace overview is code-owned (its gate permission is issues:read).
  {
    match: { exact: '/' },
    permission: 'issues:read',
    component: gated(() => import('./pages/Dashboard.js').then((m) => ({ default: m.DashboardPage })), 'The overview'),
  },
  {
    match: { prefix: '/overview' },
    permission: 'issues:read',
    component: gated(() => import('./pages/Dashboard.js').then((m) => ({ default: m.DashboardPage })), 'The overview'),
  },
]);
