import { useEffect } from 'react';
import { defineSlots, registerFreshFilter } from '@moxxy/companion-sdk/client';
import { useWorkspace } from '@companion/module-workspace/client';
import { useWorkspaceRepos } from './hooks/useWorkspaceRepos.js';

/**
 * Renders nothing. Issue and PR activity carries a repository, so it is
 * workspace-scoped: work in another workspace's repos must not light up the nav
 * of the one you are looking at. Only this module can decide that, because only
 * it knows which repos belong to the active workspace, so it registers the veto
 * instead of the shell hardcoding it.
 */
function FreshScope(): null {
  const { current } = useWorkspace();
  const repos = useWorkspaceRepos(current?.id);
  useEffect(() => {
    const inWorkspace = new Set(repos.map((r) => r.fullName));
    return registerFreshFilter((msg) =>
      msg.t === 'issues.changed' || msg.t === 'prs.changed' ? inWorkspace.has(msg.repo) : true,
    );
  }, [repos]);
  return null;
}

export const slots = defineSlots([
  {
    slot: 'shell.effects',
    key: 'code-fresh-scope',
    order: 0,
    permission: 'repos:read',
    component: FreshScope,
  },
]);
