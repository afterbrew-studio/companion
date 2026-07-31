import type { ModuleContext, ScopeResolver } from '@moxxy/companion-sdk/server';

/**
 * Who may see a pipeline step's live output.
 *
 * The hub broadcasts any message no resolver claims, which is fine for the
 * `*.changed` signals this module already emits: they carry a repository name
 * and nothing else. `pipelineStep.output` is different in kind — it carries the
 * raw stdout of a command run inside a private repository's checkout, which can
 * name files, print environment detail, or quote source. That must reach only
 * the people who may see the repository at all.
 *
 * Registered in onEnable, so disabling this module removes the claim with it.
 */
export function createStepOutputScopeResolver(ctx: ModuleContext): ScopeResolver {
  return (msg) => {
    if (msg.t !== 'pipelineStep.output') return null;
    const repo = msg.repo;
    return (username: string): boolean => {
      const role = ctx.services.get('core').userRole(username);
      if (!role) return false;
      // Same check the REST routes make before returning anything about a repo,
      // so a socket can never be a way around the workspace rule.
      return ctx.services
        .get('workspace')
        .canAccessRepo({ username, displayName: username, role }, repo);
    };
  };
}
