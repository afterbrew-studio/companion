import type { ModuleContext, ScopeResolver } from '@moxxy/companion-sdk/server';

/**
 * Who may see a pipeline step's live output.
 *
 * The hub broadcasts any message no resolver claims, which is fine for the
 * `*.changed` signals this module already emits: they carry a repository name
 * and nothing else. `pipelineStep.output` is different in kind — it carries the
 * raw stdout of a command run inside a private repository's checkout, which can
 * name files, print environment detail, or quote source. The synchronous WS
 * scope cannot perform the personal GitHub credential check used by REST, so
 * raw chunks go only to the run owner. Other maintainers read the same bounded,
 * scrubbed tail through the authenticated log route.
 *
 * Registered in onEnable, so disabling this module removes the claim with it.
 */
export function createStepOutputScopeResolver(): ScopeResolver {
  return (msg) => {
    if (msg.t !== 'pipelineStep.output') return null;
    return (username: string): boolean => username === msg.ownerId;
  };
}

/**
 * A status patch contains repository state rather than a content-free change
 * signal, so it follows the same permission + workspace boundary as the PR
 * route that would otherwise return it.
 */
export function createPrStatusScopeResolver(ctx: ModuleContext): ScopeResolver {
  return (msg) => {
    if (msg.t !== 'prStatus.changed') return null;
    return (username: string): boolean => {
      const role = ctx.services.get('core').activeUserRole(username);
      if (!role) return false;
      const user = { username, displayName: username, role };
      return ctx.rbac.allows(user, 'prs:read') && ctx.services.get('workspace').canAccessRepo(user, msg.repo);
    };
  };
}
