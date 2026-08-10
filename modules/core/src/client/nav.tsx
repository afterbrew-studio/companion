import { defineNav, defineSections, NavIcon } from '@moxxy/companion-core/client';

/**
 * Core owns every settings group, not just the ones holding its own pages.
 *
 * A settings group has to exist whenever ANY module wants to attach a page to
 * it, and an entry whose section id nobody declared is dropped from the shell
 * without a word. Only `core` is `required: true`, so only core can make that
 * promise: module-operate hangs its AI pages here, module-code its GitHub
 * account, module-notify its forwarder, none of which depend on each other.
 * Empty groups don't render, so declaring one costs nothing.
 *
 * Icons follow the shared stroke style from the legacy modules.tsx registry.
 */

export const sections = defineSections([
  { id: 'admin', label: 'Instance', order: 50, placement: 'settings' },
  { id: 'admin-ai', label: 'AI', order: 51, placement: 'settings' },
  { id: 'admin-access', label: 'Access', order: 52, placement: 'settings' },
  { id: 'admin-integrations', label: 'Integrations', order: 53, placement: 'settings' },
]);

export const nav = defineNav([
  {
    key: 'users',
    label: 'Users',
    hash: '#/users',
    shortcut: 'm',
    permission: 'users:manage',
    authModes: ['password'],
    section: 'admin-access',
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
    authModes: ['password'],
    section: 'admin-access',
    order: 25,
    icon: (
      <NavIcon>
        <path d="M12 3l7 4v5c0 4-3 6.5-7 9-4-2.5-7-5-7-9V7l7-4z" />
        <path d="M9.5 12l1.8 1.8L15 10" />
      </NavIcon>
    ),
  },
  {
    key: 'tokens',
    label: 'API tokens',
    hash: '#/tokens',
    permission: 'tokens:manage',
    section: 'admin-access',
    order: 30,
    icon: (
      <NavIcon>
        <circle cx="8" cy="12" r="4" />
        <path d="M12 12h9M17 12v3M20 12v2" />
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
  {
    key: 'audit',
    label: 'Audit trail',
    hash: '#/audit',
    permission: 'audit:read',
    section: 'admin',
    order: 30,
    icon: (
      <NavIcon>
        <path d="M5 4h11l3 3v13H5z" />
        <path d="M8.5 11.5l2 2 4-4.5" />
      </NavIcon>
    ),
  },
]);
