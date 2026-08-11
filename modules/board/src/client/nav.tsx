import { defineNav, defineQuickActions, defineSections, NavIcon } from '@moxxy/companion-sdk/client';

/**
 * The board belongs to the planning cluster, so it lives in Plan & build
 * rather than opening one of its own for two entries. module-plan declares the
 * SAME section (id dedupes, first declaration wins) and is NOT a dependency of
 * this module, so keep the two declarations identical, or a board-without-plan
 * instance loses the group and silently drops both entries.
 */
export const sections = defineSections([
  { id: 'plan', label: 'Plan & build', order: 30, audiences: ['business', 'developer'] },
]);

export const nav = defineNav([
  {
    key: 'board',
    label: 'Task board',
    hash: '#/board',
    shortcut: 'b',
    permission: 'board:read',
    section: 'plan',
    order: 40,
    audiences: ['business', 'developer'],
    icon: (
      <NavIcon>
        <path d="M4 5h4.5v10H4zM9.75 5h4.5v14h-4.5zM15.5 5H20v7h-4.5z" />
      </NavIcon>
    ),
  },
]);

export const actions = defineQuickActions([
  {
    key: 'new-task',
    label: 'Create implementation task',
    group: 'Create',
    access: ['board:read', 'board:manage'],
    keywords: 'board work card build implement',
    order: 40,
    intent: 'new-task',
  },
]);
