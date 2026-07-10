import { lazy, type ComponentType } from 'react';
import { defineClientRoutes, type RouteProps } from '@companion/core/client';

/** React.lazy over a named page export, widened to the RouteProps contract. */
const page = (load: () => Promise<ComponentType<RouteProps>>): ComponentType<RouteProps> =>
  lazy(async () => ({ default: await load() }));

// Detail pages take typed props; wrap them so RouteProps params feed through
// with the legacy key-remount semantics (switching targets remounts the page).
const IssueDetailRoute = lazy(async () => {
  const { IssueDetail } = await import('./pages/IssueDetail.js');
  const Wrapped = ({ params }: RouteProps): JSX.Element => (
    <IssueDetail key={`${params.repo}#${params.number}`} repo={params.repo!} number={Number(params.number)} />
  );
  return { default: Wrapped };
});
const PrViewRoute = lazy(async () => {
  const { PrView } = await import('./pages/pr/PrView.js');
  const Wrapped = ({ params }: RouteProps): JSX.Element => (
    <PrView key={`${params.repo}#${params.number}#${params.mode ?? ''}`} repo={params.repo!} number={Number(params.number)} mode={params.mode === 'review' ? 'review' : undefined} />
  );
  return { default: Wrapped };
});
const PrBuildRoute = lazy(async () => {
  const { PrBuild } = await import('./pages/pr/PrBuild.js');
  const Wrapped = ({ params }: RouteProps): JSX.Element => <PrBuild key={params.runId} runId={params.runId!} />;
  return { default: Wrapped };
});

export const routes = defineClientRoutes([
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
    component: page(() => import('./pages/IssuesArea.js').then((m) => m.IssuesAreaPage)),
  },
  {
    match: { prefix: '/prs' },
    permission: 'prs:read',
    component: page(() => import('./pages/PrsArea.js').then((m) => m.PrsAreaPage)),
  },
  {
    match: { prefix: '/pipelines' },
    permission: 'pipelines:read',
    component: page(() => import('./pages/Pipelines.js').then((m) => m.PipelinesPage)),
  },
  {
    match: { prefix: '/repos' },
    permission: 'repos:manage',
    component: page(() => import('./pages/ReposPage.js').then((m) => m.ReposPage)),
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
    component: page(() => import('./pages/Dashboard.js').then((m) => m.DashboardPage)),
  },
  {
    match: { prefix: '/overview' },
    permission: 'issues:read',
    component: page(() => import('./pages/Dashboard.js').then((m) => m.DashboardPage)),
  },
]);
