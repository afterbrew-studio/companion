import { defineNav, NavIcon } from '@moxxy/companion-sdk/client';

/**
 * module-automations' sidebar contributions. No group of its own: the
 * Automations entry attaches to the operate section and Daily Digest to the
 * workspace section — automations generates the digests (module ≠ group — the
 * sidebar is a shared, ordered namespace). Icons copied exactly from the
 * legacy modules.tsx registry.
 */

const icons = {
  automations: (
    <NavIcon>
      <path d="M13 3L5 13.5h5.5L11 21l8-10.5h-5.5L13 3z" />
    </NavIcon>
  ),
  digest: (
    <NavIcon>
      <path d="M4 5.5h13V17a3 3 0 0 0 3 3H7a3 3 0 0 1-3-3V5.5z" />
      <path d="M17 9h3.5v8a3 3 0 0 1-3 3" />
      <path d="M7.5 9.5h6M7.5 13h6M7.5 16.5h3.5" />
    </NavIcon>
  ),
};

export const nav = defineNav([
  {
    key: 'digest',
    label: 'Daily Digest',
    hash: '#/digest',
    shortcut: 'g',
    permission: 'reports:read',
    section: 'workspace',
    order: 10,
    freshOn: (msg) => (msg.t === 'reports.changed' ? 'digest' : null),
    icon: icons.digest,
  },
  {
    key: 'automations',
    label: 'Automations',
    hash: '#/automations',
    shortcut: 'u',
    permission: 'automations:manage',
    section: 'operate',
    order: 10,
    icon: icons.automations,
  },
]);
