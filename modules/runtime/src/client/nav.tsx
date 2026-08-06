import { defineNav, NavIcon } from '@moxxy/companion-sdk/client';

/**
 * Attaches to core's Integrations settings group rather than opening one of its
 * own: which endpoints an instance may spend money against is configuration,
 * not a daily work surface.
 */
export const nav = defineNav([
  {
    key: 'model-providers',
    label: 'Model providers',
    hash: '#/model-providers',
    permission: 'runtime:read',
    section: 'admin-integrations',
    order: 4,
    icon: (
      <NavIcon>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 9h6v6H9z" />
      </NavIcon>
    ),
  },
]);
