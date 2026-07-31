import { defineAcl } from '@moxxy/companion-sdk/server';
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
    { id: 'pipelines:execute', title: 'Run unsafe executable pipeline steps' },
    { id: 'pipelines:author-execute', title: 'Create or edit pipeline steps that execute commands' },
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
      // Runs pipelines that execute commands, but cannot author one: the
      // dangerous act is deciding WHAT runs, not clicking run on something a
      // maintainer already reviewed. Same asymmetry as a CI system, where
      // editing the workflow file is held far tighter than re-running a job.
      'pipelines:execute',
    ],
    business: ['repos:read'],
  },
});
