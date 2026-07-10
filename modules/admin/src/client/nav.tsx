import { defineNav, NavIcon } from '@companion/core/client';

/**
 * module-admin contributes the Settings entry to core's Admin sidebar group
 * (core owns the section). Icon follows the shared stroke style from the
 * legacy modules.tsx registry.
 */

export const nav = defineNav([
  {
    key: 'settings',
    label: 'Settings',
    hash: '#/settings',
    shortcut: 's',
    permission: 'settings:manage',
    section: 'admin',
    order: 30,
    icon: (
      <NavIcon>
        <circle cx="12" cy="12" r="3" />
        <path d="M19 12a7 7 0 0 0-.15-1.4l2-1.55-2-3.46-2.35.95A7 7 0 0 0 14.1 5L13.7 2.5h-3.4L9.9 5a7 7 0 0 0-2.4 1.4l-2.35-.95-2 3.46 2 1.55a7 7 0 0 0 0 2.8l-2 1.55 2 3.46 2.35-.95a7 7 0 0 0 2.4 1.4l.4 2.48h3.4l.4-2.48a7 7 0 0 0 2.4-1.4l2.35.95 2-3.46-2-1.55c.1-.45.15-.92.15-1.4z" />
      </NavIcon>
    ),
  },
]);
