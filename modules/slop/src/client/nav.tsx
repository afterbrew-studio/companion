import { defineNav, NavIcon } from '@moxxy/companion-sdk/client';

/**
 * Contribution Quality is part of reviewing incoming code, so code owners can
 * reach it from the same group as pull requests and pipelines.
 */
export const nav = defineNav([
  {
    key: 'slop',
    label: 'Contribution quality',
    hash: '#/contribution-quality',
    // The pages also answer on the original #/slop prefix (routes.tsx keeps it
    // as an alias), so legacy deep links still highlight this entry.
    owns: [/^\/slop(\/|$)/],
    // 's' is taken (workspace chord), so 't' (de-t-ect) it is.
    shortcut: 't',
    permission: 'slop:read',
    section: 'code',
    order: 30,
    audiences: ['developer'],
    freshOn: (msg) => (msg.t === 'slop.changed' ? 'slop' : null),
    icon: (
      <NavIcon>
        <path d="M11 6.5c2.5 3 4.6 5.6 4.6 8a4.75 4.75 0 0 1-9.5 0c0-2.4 2.4-5 4.9-8z" />
        <path d="M18 3v4M16 5h4" />
      </NavIcon>
    ),
  },
]);
