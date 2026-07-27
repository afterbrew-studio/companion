import { defineNav, defineSections, NavIcon } from '@companion/core/client';

/**
 * Core owns the Admin sidebar group; users + the Modules toggles live in it.
 * Icons follow the shared stroke style from the legacy modules.tsx registry.
 */

export const sections = defineSections([{ id: 'admin', label: 'Admin', order: 50 }]);

export const nav = defineNav([
  {
    key: 'users',
    label: 'Users',
    hash: '#/users',
    shortcut: 'm',
    permission: 'users:manage',
    section: 'admin',
    order: 20,
    icon: (
      <NavIcon>
        <circle cx="9" cy="8" r="3.5" />
        <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
        <path d="M16 5.5a3.5 3.5 0 0 1 0 6.6M17.5 14.5c2.1.8 3.5 2.9 3.5 5.5" />
      </NavIcon>
    ),
  },
  {
    key: 'roles',
    label: 'Roles',
    hash: '#/roles',
    shortcut: 'q',
    permission: 'users:manage',
    section: 'admin',
    order: 25,
    icon: (
      <NavIcon>
        <path d="M12 3l7 4v5c0 4-3 6.5-7 9-4-2.5-7-5-7-9V7l7-4z" />
        <path d="M9.5 12l1.8 1.8L15 10" />
      </NavIcon>
    ),
  },
  {
    key: 'modules',
    label: 'Modules',
    hash: '#/modules',
    shortcut: 'x',
    permission: 'modules:manage',
    section: 'admin',
    order: 40,
    icon: (
      <NavIcon>
        <rect x="4" y="3.5" width="16" height="5" rx="1.5" />
        <rect x="4" y="9.5" width="16" height="5" rx="1.5" />
        <rect x="4" y="15.5" width="16" height="5" rx="1.5" />
      </NavIcon>
    ),
  },
]);
