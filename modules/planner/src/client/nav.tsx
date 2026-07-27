import { defineNav, NavIcon } from '@moxxy-ai/companion-sdk/client';

export const nav = defineNav([{
  key: 'ideas',
  label: 'Ideas',
  hash: '#/ideas',
  shortcut: 'p',
  permission: 'planner:read',
  section: 'plan',
  order: -10,
  freshOn: (message) => message.t === 'planner.changed' ? 'ideas' : null,
  icon: (
    <NavIcon>
      <path d="M9 18h6M10 22h4M8.5 14.5C6.9 13.4 6 11.7 6 9.7A6 6 0 0 1 18 9.7c0 2-.9 3.7-2.5 4.8-.7.5-1.1 1.2-1.2 2H9.7c-.1-.8-.5-1.5-1.2-2z" />
    </NavIcon>
  ),
}]);
