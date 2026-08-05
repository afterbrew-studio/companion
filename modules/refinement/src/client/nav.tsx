import { defineNav, NavIcon } from '@moxxy/companion-sdk/client';

/**
 * Refinement is the codebase-to-tasks stage of planning, so it stays beside
 * ideas, specifications and the task board instead of becoming search-only.
 */
export const nav = defineNav([
  {
    key: 'refinement',
    label: 'Refinement',
    hash: '#/refinement',
    // 'r' is taken by code's Pull Requests chord — 'f' (re-f-ine) is free.
    shortcut: 'f',
    permission: 'refine:read',
    section: 'plan',
    order: 30,
    audiences: ['developer'],
    freshOn: (msg) => (msg.t === 'refinement.changed' ? 'refinement' : null),
    icon: (
      <NavIcon>
        <path d="M3.5 12h6.5" />
        <path d="M10 12c4 0 4-6 8-6M10 12h8M10 12c4 0 4 6 8 6" />
        <path d="m16.5 4 2.5 2-2.5 2M16.5 10l2.5 2-2.5 2M16.5 16l2.5 2-2.5 2" />
      </NavIcon>
    ),
  },
]);
