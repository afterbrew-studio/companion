import { defineNav, NavIcon } from '@moxxy/companion-sdk/client';

/**
 * Attaches to core's Admin group rather than opening one of its own: forwarding
 * the inbox to a third party is instance administration, and a group holding a
 * single entry is noise in the sidebar.
 */
export const nav = defineNav([
  {
    key: 'notify',
    label: 'Notifications',
    hash: '#/notify',
    permission: 'notify:read',
    section: 'admin',
    order: 8,
    icon: (
      <NavIcon>
        <path d="M18 8a6 6 0 10-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9z" />
        <path d="M13.7 21a2 2 0 01-3.4 0" />
      </NavIcon>
    ),
  },
]);
