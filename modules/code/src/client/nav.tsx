import { defineNav, defineQuickActions, defineSections, NavIcon } from '@moxxy/companion-sdk/client';

/**
 * module-code owns the workspace foundation and daily Code & review group.
 * Overview is shared Home context, while GitHub identity stays in Settings.
 * A module is not a nav group.
 * Icons copied exactly from the legacy modules.tsx registry.
 */

const icons = {
  overview: (
    <NavIcon>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </NavIcon>
  ),
  needsAttention: (
    <NavIcon>
      <path d="M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5z" />
      <path d="M10.5 19a2 2 0 0 0 3 0" />
    </NavIcon>
  ),
  issues: (
    <NavIcon>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.5" />
    </NavIcon>
  ),
  prs: (
    <NavIcon>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v7M13 6h3a2 2 0 0 1 2 2v7.5" />
    </NavIcon>
  ),
  pipelines: (
    <NavIcon>
      <rect x="3" y="4" width="6" height="6" rx="1.5" />
      <rect x="15" y="14" width="6" height="6" rx="1.5" />
      <path d="M9 7h5a2 2 0 0 1 2 2v5M6 10v5a2 2 0 0 0 2 2h5" />
    </NavIcon>
  ),
  repos: (
    <NavIcon>
      <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5z" />
      <path d="M4 18a2.5 2.5 0 0 1 2.5-2.5H20" />
    </NavIcon>
  ),
  github: (
    <NavIcon>
      <path d="M12 3a9 9 0 0 0-2.85 17.54c.45.08.62-.2.62-.44v-1.68c-2.5.54-3.03-1.06-3.03-1.06-.41-1.04-1-1.32-1-1.32-.82-.56.06-.55.06-.55.9.06 1.38.93 1.38.93.8 1.38 2.11.98 2.62.75.08-.58.31-.98.57-1.2-2-.23-4.1-1-4.1-4.45 0-.98.35-1.79.93-2.42-.1-.23-.4-1.15.08-2.4 0 0 .76-.24 2.48.92a8.6 8.6 0 0 1 4.51 0c1.72-1.16 2.47-.92 2.47-.92.49 1.25.18 2.17.09 2.4.58.63.93 1.44.93 2.42 0 3.47-2.1 4.22-4.11 4.44.32.28.61.83.61 1.67v2.47c0 .24.16.52.62.43A9 9 0 0 0 12 3z" />
    </NavIcon>
  ),
};

export const sections = defineSections([
  { id: 'workspace-manage', label: 'Workspace', order: 20 },
  { id: 'code', label: 'Code & review', order: 40, audiences: ['developer'] },
]);

export const nav = defineNav([
  {
    key: 'overview',
    label: 'Overview',
    hash: '#/overview',
    shortcut: 'o',
    permission: 'issues:read',
    section: 'workspace',
    order: -10,
    // Fallback home when the viewer cannot access Today; the shell otherwise
    // prefers Workbench's lower home order.
    home: 0,
    icon: icons.overview,
  },
  {
    key: 'needs-attention',
    label: 'Needs attention',
    hash: '#/needs-attention',
    // No shortcut: a-y are all claimed, and a meaningless letter is worse than
    // reaching this from the sidebar or the command palette.
    permission: 'issues:read',
    section: 'more',
    // Specialist triage view: Today and Daily Digest point here when the
    // aggregate is not enough.
    order: 15,
    icon: icons.needsAttention,
  },
  {
    key: 'issues',
    label: 'Issues',
    hash: '#/issues',
    shortcut: 'i',
    permission: 'issues:read',
    section: 'code',
    order: 0,
    audiences: ['developer'],
    // One issue lives under its repository's path, not under /issues.
    owns: [/^\/repos\/[\w.-]+\/[\w.-]+\/issues\/\d+/],
    icon: icons.issues,
  },
  {
    key: 'prs',
    label: 'Pull Requests',
    hash: '#/prs',
    shortcut: 'r',
    permission: 'prs:read',
    section: 'code',
    order: 10,
    audiences: ['developer'],
    // Both the detail view and its /review sibling.
    owns: [/^\/repos\/[\w.-]+\/[\w.-]+\/prs\/\d+/],
    icon: icons.prs,
  },
  {
    key: 'pipelines',
    label: 'Pipelines',
    hash: '#/pipelines',
    shortcut: 'l',
    permission: 'pipelines:read',
    section: 'code',
    order: 20,
    audiences: ['developer'],
    icon: icons.pipelines,
  },
  {
    key: 'repos',
    label: 'Repositories',
    hash: '#/repos',
    shortcut: 'e',
    permission: 'repos:read',
    // Repositories define the active workspace and remain visible to readers;
    // mutation controls still require repos:manage.
    section: 'workspace-manage',
    order: 0,
    icon: icons.repos,
  },
  {
    key: 'github',
    label: 'GitHub',
    hash: '#/github',
    shortcut: 'h',
    permission: 'github:connect',
    section: 'admin-integrations',
    order: 0,
    icon: icons.github,
  },
  {
    key: 'agent-quality',
    label: 'Agent quality',
    hash: '#/agent-quality',
    permission: 'repos:read',
    section: 'operate',
    order: 20,
    audiences: ['developer'],
    icon: (
      <NavIcon>
        <path d="M4 19V5M4 19h16" />
        <path d="M8 19v-6M13 19V9M18 19v-4" />
      </NavIcon>
    ),
  },
]);

export const actions = defineQuickActions([
  {
    key: 'connect-repo',
    label: 'Connect repository',
    group: 'Connect',
    access: ['repos:manage'],
    keywords: 'add import github repository repo',
    order: 10,
    intent: 'connect-repo',
  },
  {
    key: 'connect-github',
    label: 'Connect GitHub account',
    group: 'Connect',
    access: ['github:connect'],
    keywords: 'add github account token pat',
    order: 20,
    intent: 'connect-github',
  },
]);
