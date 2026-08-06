import { defineNav, NavIcon } from '@moxxy/companion-sdk/client';

/** Today follows the workspace overview as its focused decision queue. */
export const nav = defineNav([
  {
    key: 'today',
    label: 'Today',
    hash: '#/today',
    permission: 'workbench:read',
    section: 'workspace',
    order: -10,
    // Remains the landing fallback when a role cannot read Overview.
    home: -10,
    icon: (
      <NavIcon>
        <circle cx="12" cy="12" r="8.5" />
        <path d="m8 12 2.5 2.5L16 9" />
      </NavIcon>
    ),
  },
]);
