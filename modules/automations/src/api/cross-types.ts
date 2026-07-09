// Side-effect import: pulls all five dependency contracts' ServiceMap
// augmentations into the program so `ServiceMap['code' | 'operate' | 'plan' |
// 'workspace' | 'core']` resolve.
import '../contract/index.js';
import type { ServiceMap } from '@companion/contracts';

/**
 * Local aliases for the cross-module types this module consumes. Another
 * module's `/api` entry must never be imported, so instead of importing the
 * owners' classes the aliases are derived structurally from their service
 * bundles (`ctx.services.get(...)`) — the instances the moved bodies receive
 * are exactly those, so assignability is a given.
 */
export type OperateService = ServiceMap['operate'];
export type Orchestrator = OperateService['orchestrator'];
export type Checkouts = OperateService['checkouts'];
export type WebhookTunnel = OperateService['webhookTunnel'];
export type RunsStore = OperateService['runsStore'];

export type CodeService = ServiceMap['code'];
export type ReposStore = CodeService['repos'];
export type IssuesStore = CodeService['issues'];
export type PrsStore = CodeService['prs'];
export type GitHubSync = CodeService['sync'];
export type Triage = CodeService['triage'];
export type PrReviews = CodeService['prReviews'];
export type PrChecks = CodeService['prChecks'];
export type Pipelines = CodeService['pipelines'];
/** The resolved GitHub API client (code's registry hands these out per purpose). */
export type GitHubClient = NonNullable<ReturnType<CodeService['githubAccounts']['clientFor']>>;
/** Webhook payload object shapes, as the sync cache's apply methods accept them. */
export type GhIssue = Parameters<GitHubSync['applyIssue']>[1];
export type GhPull = Parameters<GitHubSync['applyPull']>[1];
/** A repos-table row as code's store returns it (snake_case; the legacy shape). */
export type RepoRow = NonNullable<ReturnType<ReposStore['get']>>;

export type PlanService = ServiceMap['plan'];
export type Specs = PlanService['specs'];

/** module-core's Auth service (AI Help mints scoped API tokens through it). */
export type Auth = ServiceMap['core'];
