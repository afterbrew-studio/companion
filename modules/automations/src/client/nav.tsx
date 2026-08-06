import { defineNav, defineQuickActions, NavIcon } from '@moxxy/companion-sdk/client';

/**
 * Daily Digest is shared Home context. Repository automation configuration is
 * reached from Repositories, while AI Help reaches the top bar through a slot.
 */

const icons = {
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
    order: 0,
    freshOn: (msg) => (msg.t === 'reports.changed' ? 'digest' : null),
    icon: icons.digest,
  },
]);

export const actions = defineQuickActions([
  {
    key: 'ask-ai',
    label: 'Ask AI Help',
    group: 'Help',
    access: ['runs:read', 'runs:act'],
    keywords: 'assistant explain find draft help companion',
    order: 0,
    intent: 'ask-ai',
  },
]);
