import { defineNav, defineSections } from '@companion/core/client';

/**
 * module-workspace owns the Workspace sidebar group; the Daily Digest entry
 * lives in it (Overview ships with module-code — its guard permission is
 * code's). Icons follow the shared stroke style from the legacy modules.tsx
 * registry.
 */

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

export const sections = defineSections([{ id: 'workspace', label: 'Workspace', order: 10 }]);

export const nav = defineNav([
  {
    key: 'digest',
    label: 'Daily Digest',
    hash: '#/digest',
    shortcut: 'g',
    permission: 'reports:read',
    section: 'workspace',
    order: 10,
    freshOn: (msg) => (msg.t === 'reports.changed' ? 'digest' : null),
    icon: (
      <svg viewBox="0 0 24 24" className="size-4" aria-hidden {...stroke}>
        <path d="M4 5.5h13V17a3 3 0 0 0 3 3H7a3 3 0 0 1-3-3V5.5z" />
        <path d="M17 9h3.5v8a3 3 0 0 1-3 3" />
        <path d="M7.5 9.5h6M7.5 13h6M7.5 16.5h3.5" />
      </svg>
    ),
  },
]);
