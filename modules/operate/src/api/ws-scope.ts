import type { ModuleContext, ScopeResolver } from '@moxxy/companion-core/server';

/**
 * Run-stream visibility (the legacy SpaHub closures, relocated to their owner).
 * A run's record/events/turns/asks only reach users who may see the run:
 * attended chats (interactive / AI Help) reach their owner only; repo runs
 * reach whoever can access the repo's workspace. Registered with the hub in
 * onEnable, so disabling operate removes the claim with it.
 */

/** The bits of a run needed to decide who may see its stream. */
interface RunVisibility {
  readonly repo: string | null;
  readonly kind: string;
  readonly userId: string | null;
}

export function createRunScopeResolver(ctx: ModuleContext): ScopeResolver {
  /** run id → its visibility, cached so per-message filtering avoids store hits. */
  const cache = new Map<string, RunVisibility | null>();

  const lookup = (runId: string): RunVisibility | null => {
    let info = cache.get(runId);
    if (info === undefined) {
      const run = ctx.services.get('operate').orchestrator.getRun(runId);
      info = run ? { repo: run.repo, kind: run.kind, userId: run.userId } : null;
      cache.set(runId, info);
    }
    return info;
  };

  // Delegates to the single owner of run visibility (OperateService.canSeeRun);
  // only the username→role lift is local to the socket path.
  const canSee = (username: string, info: RunVisibility): boolean => {
    const role = ctx.services.get('core').activeUserRole(username);
    if (!role) return false;
    return ctx.services.get('operate').canSeeRun({ username, displayName: username, role }, info);
  };

  return (msg) => {
    let info: RunVisibility | null = null;
    if (msg.t === 'run.changed') {
      info = { repo: msg.run.repo, kind: msg.run.kind, userId: msg.run.userId };
      cache.set(msg.run.id, info);
    } else if (msg.t === 'event' || msg.t === 'turn' || msg.t === 'ask' || msg.t === 'askResolved') {
      info = lookup(msg.runId);
    }
    if (!info) return null;
    const captured = info;
    return (username) => canSee(username, captured);
  };
}
