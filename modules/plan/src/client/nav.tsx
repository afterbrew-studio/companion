import { defineNav, defineQuickActions, defineSections, NavIcon } from '@moxxy/companion-sdk/client';

/**
 * module-plan's sidebar contributions: the Plan & build group with its
 * specifications and documentation entries. module-board declares the SAME section
 * (id dedupes, first declaration wins) because it does not depend on this module,
 * so keep the two declarations identical. Icons copied exactly from the legacy
 * modules.tsx registry.
 */

const icons = {
  proposals: (
    <NavIcon>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
      <circle cx="12" cy="12" r="3.5" />
    </NavIcon>
  ),
  specs: (
    <NavIcon>
      <path d="M6 3h9l4 4v14H6a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 6 3z" />
      <path d="M15 3v4h4M8.5 11h7M8.5 14.5h7M8.5 18h4" />
    </NavIcon>
  ),
  docs: (
    <NavIcon>
      <path d="M12 6.5C10.5 5 8.5 4.5 5.5 4.5c-1 0-2 .15-3 .5v14c1-.35 2-.5 3-.5 3 0 5 .5 6.5 2 1.5-1.5 3.5-2 6.5-2 1 0 2 .15 3 .5v-14c-1-.35-2-.5-3-.5-3 0-5 .5-6.5 2z" />
      <path d="M12 6.5v14" />
    </NavIcon>
  ),
};

export const sections = defineSections([
  { id: 'plan', label: 'Plan & build', order: 30, audiences: ['business', 'developer'] },
]);

export const nav = defineNav([
  {
    key: 'specs',
    label: 'Specifications',
    hash: '#/specs',
    shortcut: 'c',
    permission: 'specs:read',
    section: 'plan',
    order: 10,
    audiences: ['business', 'developer'],
    freshOn: (msg) => (msg.t === 'specs.changed' ? 'specs' : null),
    icon: icons.specs,
  },
  {
    key: 'docs',
    label: 'Documentation',
    hash: '#/docs',
    shortcut: 'd',
    permission: 'docs:read',
    section: 'plan',
    order: 20,
    audiences: ['business', 'developer'],
    freshOn: (msg) => (msg.t === 'docs.changed' ? 'docs' : null),
    icon: icons.docs,
  },
]);

export const actions = defineQuickActions([
  {
    key: 'new-spec',
    label: 'Write specification',
    group: 'Create',
    access: ['specs:read', 'specs:manage'],
    keywords: 'requirements requirement spec feature behavior',
    order: 20,
    intent: 'new-spec',
  },
  {
    key: 'new-doc',
    label: 'Write documentation',
    group: 'Create',
    access: ['docs:read', 'docs:manage'],
    keywords: 'knowledge document runbook architecture content',
    order: 30,
    intent: 'new-doc',
  },
]);
