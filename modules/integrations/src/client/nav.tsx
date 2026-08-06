import { defineNav, NavIcon } from '@moxxy/companion-sdk/client';

export const nav = defineNav([
  {
    key: 'integrations',
    label: 'Integrations',
    hash: '#/integrations',
    permission: 'integrations:read',
    section: 'admin-integrations',
    order: 10,
    icon: (
      <NavIcon>
        <path d="M8 12h8M12 8v8" />
        <path d="M7 3h3v4H7a5 5 0 000 10h3v4H7a9 9 0 010-18zM17 3h-3v4h3a5 5 0 010 10h-3v4h3a9 9 0 000-18z" />
      </NavIcon>
    ),
  },
]);
