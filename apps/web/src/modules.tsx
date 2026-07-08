import type { Permission } from '@companion/contract';

/**
 * The module registry — the SPA equivalent of the server's route registries.
 * A module is a top-level area: nav entry + hash + required permission +
 * keyboard chord. Adding an area (a future integration) = one entry here plus
 * a page component wired in App.tsx; nav, RBAC filtering, and shortcuts pick
 * it up automatically.
 */

export interface AppModule {
  readonly key: string;
  readonly label: string;
  readonly hash: string;
  /** `g` + this key jumps to the module. */
  readonly shortcut: string;
  readonly permission: Permission;
  readonly section: 'workspace' | 'plan' | 'code' | 'operate' | 'admin';
  readonly icon: JSX.Element;
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const icons = {
  overview: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden {...stroke}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </svg>
  ),
  proposals: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden {...stroke}>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  ),
  specs: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden {...stroke}>
      <path d="M6 3h9l4 4v14H6a1.5 1.5 0 0 1-1.5-1.5v-15A1.5 1.5 0 0 1 6 3z" />
      <path d="M15 3v4h4M8.5 11h7M8.5 14.5h7M8.5 18h4" />
    </svg>
  ),
  docs: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden {...stroke}>
      <path d="M12 6.5C10.5 5 8.5 4.5 5.5 4.5c-1 0-2 .15-3 .5v14c1-.35 2-.5 3-.5 3 0 5 .5 6.5 2 1.5-1.5 3.5-2 6.5-2 1 0 2 .15 3 .5v-14c-1-.35-2-.5-3-.5-3 0-5 .5-6.5 2z" />
      <path d="M12 6.5v14" />
    </svg>
  ),
  issues: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden {...stroke}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  ),
  reviews: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden {...stroke}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <path d="m9.8 12 1.6 1.6 3-3.4" />
    </svg>
  ),
  prs: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden {...stroke}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v7M13 6h3a2 2 0 0 1 2 2v7.5" />
    </svg>
  ),
  pipelines: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden {...stroke}>
      <rect x="3" y="4" width="6" height="6" rx="1.5" />
      <rect x="15" y="14" width="6" height="6" rx="1.5" />
      <path d="M9 7h5a2 2 0 0 1 2 2v5M6 10v5a2 2 0 0 0 2 2h5" />
    </svg>
  ),
  runs: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden {...stroke}>
      <path d="M8 6l-5 6 5 6M16 6l5 6-5 6" />
    </svg>
  ),
  automations: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden {...stroke}>
      <path d="M13 3L5 13.5h5.5L11 21l8-10.5h-5.5L13 3z" />
    </svg>
  ),
  repos: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden {...stroke}>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5z" />
      <path d="M4 18a2.5 2.5 0 0 1 2.5-2.5H20" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden {...stroke}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.15-1.4l2-1.55-2-3.46-2.35.95A7 7 0 0 0 14.1 5L13.7 2.5h-3.4L9.9 5a7 7 0 0 0-2.4 1.4l-2.35-.95-2 3.46 2 1.55a7 7 0 0 0 0 2.8l-2 1.55 2 3.46 2.35-.95a7 7 0 0 0 2.4 1.4l.4 2.48h3.4l.4-2.48a7 7 0 0 0 2.4-1.4l2.35.95 2-3.46-2-1.55c.1-.45.15-.92.15-1.4z" />
    </svg>
  ),
  skills: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden {...stroke}>
      <path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4L12 3z" />
      <path d="M18.5 15l.9 2.3 2.1.7-2.1.7-.9 2.3-.9-2.3-2.1-.7 2.1-.7.9-2.3z" />
    </svg>
  ),
  providers: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden {...stroke}>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" />
      <path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" />
    </svg>
  ),
  github: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden {...stroke}>
      <path d="M12 3a9 9 0 0 0-2.85 17.54c.45.08.62-.2.62-.44v-1.68c-2.5.54-3.03-1.06-3.03-1.06-.41-1.04-1-1.32-1-1.32-.82-.56.06-.55.06-.55.9.06 1.38.93 1.38.93.8 1.38 2.11.98 2.62.75.08-.58.31-.98.57-1.2-2-.23-4.1-1-4.1-4.45 0-.98.35-1.79.93-2.42-.1-.23-.4-1.15.08-2.4 0 0 .76-.24 2.48.92a8.6 8.6 0 0 1 4.51 0c1.72-1.16 2.47-.92 2.47-.92.49 1.25.18 2.17.09 2.4.58.63.93 1.44.93 2.42 0 3.47-2.1 4.22-4.11 4.44.32.28.61.83.61 1.67v2.47c0 .24.16.52.62.43A9 9 0 0 0 12 3z" />
    </svg>
  ),
  users: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden {...stroke}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <path d="M16 5.5a3.5 3.5 0 0 1 0 6.6M17.5 14.5c2.1.8 3.5 2.9 3.5 5.5" />
    </svg>
  ),
  runners: (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden {...stroke}>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M6.5 7.5h.01M6.5 16.5h.01" />
    </svg>
  ),
};

export const MODULES: readonly AppModule[] = [
  {
    key: 'overview',
    label: 'Overview',
    hash: '#/overview',
    shortcut: 'o',
    permission: 'issues:read',
    section: 'workspace',
    icon: icons.overview,
  },
  {
    key: 'reviews',
    label: 'Reviews',
    hash: '#/reviews',
    shortcut: 'w',
    permission: 'runs:read',
    section: 'workspace',
    icon: icons.reviews,
  },
  {
    key: 'proposals',
    label: 'Proposals',
    hash: '#/proposals',
    shortcut: 'p',
    permission: 'proposals:read',
    section: 'plan',
    icon: icons.proposals,
  },
  {
    key: 'specs',
    label: 'Specifications',
    hash: '#/specs',
    shortcut: 'c',
    permission: 'specs:read',
    section: 'plan',
    icon: icons.specs,
  },
  {
    key: 'docs',
    label: 'Documentation',
    hash: '#/docs',
    shortcut: 'd',
    permission: 'docs:read',
    section: 'plan',
    icon: icons.docs,
  },
  {
    key: 'issues',
    label: 'Issues',
    hash: '#/issues',
    shortcut: 'i',
    permission: 'issues:read',
    section: 'code',
    icon: icons.issues,
  },
  {
    key: 'prs',
    label: 'Pull Requests',
    hash: '#/prs',
    shortcut: 'r',
    permission: 'prs:read',
    section: 'code',
    icon: icons.prs,
  },
  {
    key: 'pipelines',
    label: 'Pipelines',
    hash: '#/pipelines',
    shortcut: 'l',
    permission: 'pipelines:read',
    section: 'code',
    icon: icons.pipelines,
  },
  {
    key: 'runs',
    label: 'Agent Runs',
    hash: '#/runs',
    shortcut: 'a',
    permission: 'runs:read',
    section: 'operate',
    icon: icons.runs,
  },
  {
    key: 'automations',
    label: 'Automations',
    hash: '#/automations',
    shortcut: 'u',
    permission: 'automations:manage',
    section: 'operate',
    icon: icons.automations,
  },
  {
    key: 'repos',
    label: 'Repositories',
    hash: '#/repos',
    shortcut: 'e',
    permission: 'repos:manage',
    section: 'operate',
    icon: icons.repos,
  },
  {
    key: 'skills',
    label: 'Skills',
    hash: '#/skills',
    shortcut: 'k',
    permission: 'skills:manage',
    section: 'operate',
    icon: icons.skills,
  },
  {
    key: 'providers',
    label: 'Providers',
    hash: '#/providers',
    shortcut: 'v',
    permission: 'settings:manage',
    section: 'admin',
    icon: icons.providers,
  },
  {
    key: 'github',
    label: 'GitHub',
    hash: '#/github',
    shortcut: 'h',
    permission: 'settings:manage',
    section: 'admin',
    icon: icons.github,
  },
  {
    key: 'runners',
    label: 'Runners',
    hash: '#/runners',
    shortcut: 'n',
    permission: 'runners:manage',
    section: 'admin',
    icon: icons.runners,
  },
  {
    key: 'users',
    label: 'Users',
    hash: '#/users',
    shortcut: 'm',
    permission: 'users:manage',
    section: 'admin',
    icon: icons.users,
  },
  {
    key: 'settings',
    label: 'Settings',
    hash: '#/settings',
    shortcut: 's',
    permission: 'settings:manage',
    section: 'admin',
    icon: icons.settings,
  },
];
