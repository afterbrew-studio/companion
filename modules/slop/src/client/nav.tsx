import { defineNav, NavIcon } from '@moxxy/companion-sdk/client';

/**
 * One entry in the Code group, after Pipelines (code owns the section; code is
 * a hard dependency, so the section always exists when this nav loads). The
 * icon is a droplet of goo with a sparkle: detected AI slop.
 */
export const nav = defineNav([
  {
    key: 'slop',
    label: 'Slop Detection',
    hash: '#/slop',
    // 's' is taken (workspace chord), so 't' (de-t-ect) it is.
    shortcut: 't',
    permission: 'slop:read',
    section: 'code',
    order: 25,
    freshOn: (msg) => (msg.t === 'slop.changed' ? 'slop' : null),
    icon: (
      <NavIcon>
        <path d="M11 6.5c2.5 3 4.6 5.6 4.6 8a4.75 4.75 0 0 1-9.5 0c0-2.4 2.4-5 4.9-8z" />
        <path d="M18 3v4M16 5h4" />
      </NavIcon>
    ),
  },
]);
