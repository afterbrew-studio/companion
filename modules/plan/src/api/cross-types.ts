// Side-effect import: pulls operate's/code's (and core's/workspace's)
// ServiceMap augmentations into the program so `ServiceMap['operate']` and
// `ServiceMap['code']` resolve.
import '../contract/index.js';
import type { ServiceMap } from '@moxxy/companion-sdk';

/**
 * Local aliases for the execution-plane and code-domain types this module
 * consumes. Another module's `/api` entry must never be imported, so instead
 * of importing operate's/code's classes the aliases are derived structurally
 * from their service bundles (`ctx.services.get('operate' | 'code')`) — the
 * instances the moved bodies receive are exactly those, so assignability is a
 * given.
 */
export type OperateService = ServiceMap['operate'];
export type Orchestrator = OperateService['orchestrator'];
export type Checkouts = OperateService['checkouts'];

export type CodeService = ServiceMap['code'];
export type Fixes = CodeService['fixes'];
export type ReposStore = CodeService['repos'];
export type PrsStore = CodeService['prs'];
/** The resolved GitHub API client (code's registry hands these out per purpose). */
export type GitHubClient = NonNullable<ReturnType<CodeService['githubAccounts']['clientFor']>>;
