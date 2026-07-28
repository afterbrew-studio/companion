import { defineNav, defineSections, NavIcon } from '@moxxy/companion-sdk/client';

/**
 * The Playground sidebar group. module-operate declares the SAME section (id
 * dedupes, first declaration wins) so its Skills entry keeps a home when this
 * module is disabled — keep the two declarations identical.
 */

export const sections = defineSections([{ id: 'playground', label: 'Playground', order: 45 }]);

export const nav = defineNav([
  {
    key: 'playground-agent',
    label: 'Agent Lab',
    hash: '#/playground',
    shortcut: 'y',
    permission: 'playground:run',
    section: 'playground',
    order: 0,
    // Flask — experiments happen here.
    icon: (
      <NavIcon>
        <path d="M10 3h4M10.5 3v5.2L5.8 17a2 2 0 0 0 1.8 3h8.8a2 2 0 0 0 1.8-3l-4.7-8.8V3" />
        <path d="M8 14h8" />
      </NavIcon>
    ),
  },
  {
    key: 'playground-pipelines',
    label: 'Pipeline Lab',
    hash: '#/playground/pipelines',
    shortcut: 'j',
    permission: 'playground:run',
    section: 'playground',
    order: 10,
    icon: (
      <NavIcon>
        <circle cx="5" cy="12" r="2" />
        <circle cx="12" cy="12" r="2" />
        <circle cx="19" cy="12" r="2" />
        <path d="M7 12h3M14 12h3" />
      </NavIcon>
    ),
  },
]);
