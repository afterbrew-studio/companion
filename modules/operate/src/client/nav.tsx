import { defineNav, defineSections, NavIcon } from '@companion/core/client';

/**
 * Operate owns the Operate sidebar group (agent runs) and attaches its
 * machine/provider admin pages to core's Admin group. Icons follow the
 * shared stroke style from the legacy modules.tsx registry.
 *
 * Skills sits in the PLAYGROUND group but stays owned by operate: the page,
 * route and API live here so the skill library keeps working when
 * module-playground is disabled. Because the shell drops nav entries whose
 * section id no enabled module declares, operate declares the 'playground'
 * section too — sections dedupe by id (first declaration wins), so the twin
 * declaration in module-playground's nav is harmless as long as the two stay
 * identical. Chosen over relocating the page into playground, which would
 * have killed #/skills whenever playground is off.
 */

export const sections = defineSections([
  { id: 'operate', label: 'Operate', order: 40 },
  { id: 'playground', label: 'Playground', order: 45 },
]);

export const nav = defineNav([
  {
    key: 'runs',
    label: 'Agent Runs',
    hash: '#/runs',
    shortcut: 'a',
    permission: 'runs:read',
    section: 'operate',
    order: 0,
    icon: (
      <NavIcon>
        <path d="M8 6l-5 6 5 6M16 6l5 6-5 6" />
      </NavIcon>
    ),
  },
  {
    key: 'skills',
    label: 'Skills',
    hash: '#/skills',
    shortcut: 'k',
    permission: 'skills:manage',
    section: 'playground',
    order: 40,
    icon: (
      <NavIcon>
        <path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4L12 3z" />
        <path d="M18.5 15l.9 2.3 2.1.7-2.1.7-.9 2.3-.9-2.3-2.1-.7 2.1-.7.9-2.3z" />
      </NavIcon>
    ),
  },
  {
    key: 'providers',
    label: 'Providers',
    hash: '#/providers',
    shortcut: 'v',
    permission: 'settings:manage',
    section: 'admin',
    order: 0,
    icon: (
      <NavIcon>
        <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
        <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
      </NavIcon>
    ),
  },
  {
    key: 'runners',
    label: 'Runners',
    hash: '#/runners',
    shortcut: 'n',
    permission: 'runners:manage',
    section: 'admin',
    order: 10,
    icon: (
      <NavIcon>
        <rect x="3" y="4" width="18" height="7" rx="1.5" />
        <rect x="3" y="13" width="18" height="7" rx="1.5" />
        <path d="M6.5 7.5h.01M6.5 16.5h.01" />
      </NavIcon>
    ),
  },
]);
