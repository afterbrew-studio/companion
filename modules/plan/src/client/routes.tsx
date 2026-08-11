import { RequiresRepo } from '@companion/module-code/client';
import { defineClientRoutes, lazyView, page, type RouteProps } from '@moxxy/companion-sdk/client';

const SpecsPage = lazyView(async () => {
  const { SpecsPage: Inner } = await import('./pages/Specs.js');
  const GatedSpecs = (_props: RouteProps): React.JSX.Element => (
    <RequiresRepo what="Specifications">
      <Inner />
    </RequiresRepo>
  );
  return { default: GatedSpecs };
});

export const routes = defineClientRoutes([
  {
    match: { prefix: '/legacy-proposals' },
    permission: 'proposals:read',
    component: page(() => import('./pages/Proposals.js').then((m) => m.ProposalsPage)),
  },
  {
    match: { prefix: '/specs' },
    permission: 'specs:read',
    component: SpecsPage,
  },
  {
    match: { prefix: '/docs' },
    permission: 'docs:read',
    component: page(() => import('./pages/Docs.js').then((m) => m.DocsPage)),
  },
]);
