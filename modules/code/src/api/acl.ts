import { defineAcl } from '@moxxy-ai/companion-sdk/server';
import '../contract/index.js';

/**
 * Mirrors today's ROLE_PERMISSIONS for the code domain: admin holds all;
 * maintainer runs the whole GitHub board day-to-day (none of these are
 * admin-only instance administration); business only sees the repo list.
 */
export default defineAcl({
  permissions: [
    { id: 'repos:read', title: 'View connected repositories' },
    { id: 'repos:manage', title: 'Connect and manage repositories' },
    { id: 'issues:read', title: 'View issues and triage results' },
    { id: 'issues:act', title: 'Act on issues (triage, fix, comment)' },
    { id: 'prs:read', title: 'View pull requests and reviews' },
    { id: 'prs:act', title: 'Act on pull requests (review, merge, fix)' },
    { id: 'pipelines:read', title: 'View pipelines and their runs' },
    { id: 'pipelines:manage', title: 'Create and edit pipelines' },
    { id: 'pipelines:run', title: 'Run pipelines' },
    { id: 'github:connect', title: 'Connect a GitHub account' },
  ],
  grants: {
    admin: '*',
    maintainer: [
      'repos:read',
      'repos:manage',
      'issues:read',
      'issues:act',
      'prs:read',
      'prs:act',
      'pipelines:read',
      'pipelines:manage',
      'pipelines:run',
      'github:connect',
    ],
    business: ['repos:read'],
  },
});
