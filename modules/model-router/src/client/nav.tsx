import { defineNav, NavIcon } from '@moxxy/companion-sdk/client';

export const nav = defineNav([
  {
    key: 'model-router',
    label: 'Model Router',
    hash: '#/model-router',
    permission: 'model-router:read',
    section: 'admin-ai',
    order: 3,
    icon: (
      <NavIcon>
        <path d="M4 6h7a4 4 0 0 1 4 4v8" />
        <path d="m12 15 3 3 3-3" />
        <path d="M4 18h4M4 12h4" />
      </NavIcon>
    ),
  },
]);
