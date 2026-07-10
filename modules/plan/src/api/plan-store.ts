import { legacyNotifications, type NotificationEmitter } from '@companion/core/server';
import type { ProposalsStore } from './proposals-store.js';
import type { SpecsStore } from './specs-store.js';
import type { DocsStore } from './docs-store.js';
import type { PrsStore, ReposStore } from './cross-types.js';

/**
 * The plan domain's view of persistence — a same-shape stand-in for the legacy
 * Store facade so the moved service bodies (proposals/specs/docs) stay
 * verbatim. Own stores are real instances; the cross-module members are
 * injected: `settings` (module-core; the per-workspace area-storage configs),
 * `repos` + `prs` (module-code's stores, reached through its service bundle —
 * a hard dependency, so reads never degrade), and `notifications` (an adapter
 * over ctx.notify for the spec-drift inbox alerts).
 */
export class PlanStore {
  readonly proposals: ProposalsStore;
  readonly specs: SpecsStore;
  readonly docs: DocsStore;
  readonly repos: ReposStore;
  readonly prs: PrsStore;
  readonly settings: { get(key: string): string | null; set(key: string, value: string): void };
  private readonly notify: NotificationEmitter;

  constructor(opts: {
    proposals: ProposalsStore;
    specs: SpecsStore;
    docs: DocsStore;
    repos: ReposStore;
    prs: PrsStore;
    settings: { get(key: string): string | null; set(key: string, value: string): void };
    notify: NotificationEmitter;
  }) {
    this.proposals = opts.proposals;
    this.specs = opts.specs;
    this.docs = opts.docs;
    this.repos = opts.repos;
    this.prs = opts.prs;
    this.settings = opts.settings;
    this.notify = opts.notify;
  }

  /** Legacy `notifications.insert({...})` call shape, routed through the shared emitter. */
  readonly notifications = legacyNotifications(() => this.notify);
}
