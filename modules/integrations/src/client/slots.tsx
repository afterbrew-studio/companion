import { defineSlots } from '@moxxy/companion-sdk/client';

function RepositoryIntegrationsLink(props: Record<string, unknown>): JSX.Element | null {
  const repo = typeof props.repo === 'string' ? props.repo : null;
  if (!repo) return null;
  return (
    <a className="btn-ghost" href={`#/repos/${repo}/integrations`} aria-label={`Manage integrations for ${repo}`}>
      Integrations
    </a>
  );
}

export const slots = defineSlots([
  {
    slot: 'repos.card.actions',
    key: 'repository-integrations',
    order: 20,
    permission: 'integrations:read',
    component: RepositoryIntegrationsLink,
  },
]);
