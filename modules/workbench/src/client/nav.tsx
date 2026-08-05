import { defineNav, NavIcon } from '@moxxy/companion-sdk/client';

/** Today claims the front page while leaving every owning domain reachable. */
export const nav = defineNav([
  {
    key: 'today',
    label: 'Today',
    hash: '#/today',
    permission: 'workbench:read',
    section: 'workspace',
    order: -20,
    home: -20,
    icon: (
      <NavIcon>
        <circle cx="12" cy="12" r="8.5" />
        <path d="m8 12 2.5 2.5L16 9" />
      </NavIcon>
    ),
  },
]);
