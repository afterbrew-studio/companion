import { defineNav, NavIcon } from '@moxxy/companion-sdk/client';

/**
 * Attaches to core's settings groups rather than opening one of its own: which
 * endpoints an instance may spend money against is configuration, not a daily
 * work surface. Model endpoints sit in the AI group beside operate's
 * Machines & models page; MCP servers stay under Integrations.
 */
export const nav = defineNav([
  {
    key: 'model-providers',
    label: 'Model endpoints',
    hash: '#/model-providers',
    permission: 'runtime:read',
    section: 'admin-ai',
    order: 4,
    icon: (
      <NavIcon>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M9 9h6v6H9z" />
      </NavIcon>
    ),
  },
  {
    key: 'mcp-servers',
    label: 'MCP servers',
    hash: '#/mcp-servers',
    permission: 'runtime:read',
    section: 'admin-integrations',
    order: 5,
    icon: (
      <NavIcon>
        <path d="M4 7h16" />
        <path d="M4 12h16" />
        <path d="M4 17h10" />
      </NavIcon>
    ),
  },
]);
