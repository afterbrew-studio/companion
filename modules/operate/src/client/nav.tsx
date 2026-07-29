import { defineNav, defineSections, NavIcon } from '@moxxy/companion-core/client';

/**
 * Operate owns the Operate sidebar group (agent runs, runners, skills) and
 * attaches its provider/model admin pages to core's Admin group. Icons follow
 * the shared stroke style from the legacy modules.tsx registry.
 *
 * Skills lives in operate's OWN group: the page, route and API are operate's,
 * and module-playground is not installed by default, so hanging the entry off
 * the Playground group would leave a group containing nothing else on a fresh
 * instance.
 */

export const sections = defineSections([{ id: 'operate', label: 'Operate', order: 40 }]);

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
    section: 'operate',
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
    key: 'task-models',
    label: 'Task models',
    hash: '#/task-models',
    permission: 'settings:manage',
    section: 'admin',
    order: 5,
    icon: (
      <NavIcon>
        <path d="M4 7h10M4 12h16M4 17h7" />
        <circle cx="17.5" cy="7" r="2.5" />
        <circle cx="13.5" cy="17" r="2.5" />
      </NavIcon>
    ),
  },
  {
    key: 'spend',
    label: 'Spend',
    hash: '#/spend',
    permission: 'settings:manage',
    section: 'admin',
    order: 7,
    icon: (
      <NavIcon>
        <path d="M12 3v18" />
        <path d="M16 7.5c0-1.4-1.8-2.5-4-2.5S8 6.1 8 7.5s1.8 2.2 4 2.5 4 1.1 4 2.5-1.8 2.5-4 2.5-4-1.1-4-2.5" />
      </NavIcon>
    ),
  },
  {
    key: 'runners',
    label: 'Runners',
    hash: '#/runners',
    shortcut: 'n',
    // Every role can inspect the shared pool and connect private machines.
    permission: 'runners:connect',
    section: 'operate',
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
