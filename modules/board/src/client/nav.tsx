import { defineNav, defineSections, NavIcon } from '@companion/core/client';

export const sections = defineSections([{ id: 'board', label: 'Board', order: 15 }]);

export const nav = defineNav([
  {
    key: 'board',
    label: 'Task Board',
    hash: '#/board',
    shortcut: 'b',
    permission: 'board:read',
    section: 'board',
    order: 0,
    icon: (
      <NavIcon>
        <path d="M4 5h4.5v10H4zM9.75 5h4.5v14h-4.5zM15.5 5H20v7h-4.5z" />
      </NavIcon>
    ),
  },
]);
