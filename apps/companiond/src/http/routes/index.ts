import type { CompiledRoute } from '../router.js';
import type { ApiDeps } from '../deps.js';
import { authRoutes } from './auth.js';
import { profileRoutes } from './profile.js';
import { userRoutes } from './users.js';
import { systemRoutes } from './system.js';
import { workspaceRoutes } from './workspaces.js';
import { repoRoutes } from './repos.js';
import { issueRoutes } from './issues.js';
import { prRoutes } from './prs.js';
import { proposalRoutes } from './proposals.js';
import { specRoutes } from './specs.js';
import { docRoutes } from './docs.js';
import { assistantRoutes } from './assistant.js';
import { pipelineRoutes } from './pipelines.js';
import { runRoutes } from './runs.js';
import { notificationRoutes } from './notifications.js';
import { generateRoutes } from './generate.js';
import { githubRoutes } from './github.js';
import { runnerRoutes } from './runners.js';

/**
 * The whole API is the concatenation of per-module route registries. Adding a
 * module (a future "area") = one file exporting `CompiledRoute[]` + one line
 * here. Order matters only for identical patterns (there are none).
 */
export function buildRoutes(deps: ApiDeps): CompiledRoute[] {
  return [
    ...authRoutes(deps),
    ...profileRoutes(deps),
    ...userRoutes(deps),
    ...systemRoutes(deps),
    ...workspaceRoutes(deps),
    ...repoRoutes(deps),
    ...issueRoutes(deps),
    ...prRoutes(deps),
    ...proposalRoutes(deps),
    ...specRoutes(deps),
    ...docRoutes(deps),
    ...assistantRoutes(deps),
    ...pipelineRoutes(deps),
    ...runRoutes(deps),
    ...notificationRoutes(deps),
    ...generateRoutes(deps),
    ...githubRoutes(deps),
    ...runnerRoutes(deps),
  ];
}
