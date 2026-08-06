import { defineClientRoutes, lazyView, page, type RouteProps } from '@moxxy/companion-sdk/client';

const RepositoryIntegrationsRoute = lazyView(async () => {
  const { RepositoryIntegrationsPage } = await import('./pages/RepositoryIntegrations.js');
  const Wrapped = ({ params }: RouteProps): JSX.Element => (
    <RepositoryIntegrationsPage key={params.repo} repo={params.repo!} />
  );
  return { default: Wrapped };
});

export const routes = defineClientRoutes([
  {
    match: {
      regex: /^\/repos\/([\w.-]+)\/([\w.-]+)\/integrations$/,
      params: (match) => ({ repo: `${match[1]}/${match[2]}` }),
    },
    permission: 'integrations:read',
    component: RepositoryIntegrationsRoute,
  },
  {
    match: { exact: '/integrations' },
    permission: 'integrations:read',
    component: page(() => import('./pages/Integrations.js').then((module) => module.IntegrationsPage)),
  },
]);
