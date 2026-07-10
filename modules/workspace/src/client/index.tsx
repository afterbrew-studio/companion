import { defineClientModule } from '@companion/core/client';
import manifest from '../module.js';
import { nav, sections } from './nav.js';
import { routes } from './routes.js';

/**
 * The `/client` barrel — module-workspace's web surface: the workspace provider
 * the shell wraps the app in, the header inbox bell, plus the Digest/Inbox
 * routes and the Workspace sidebar group. Vite reads this as source.
 */

// The shell (and other modules) reach these by name — everything else is routed.
export { WorkspaceProvider, useWorkspace } from './lib/workspace.js';
export { Inbox } from './components/Inbox.js';
export { useNotifications } from './hooks/useNotifications.js';
export { useWorkspaceMembers } from './hooks/useWorkspaceMembers.js';
export { workspaceApi } from './api.js';

export default defineClientModule({
  manifest,
  sections,
  nav,
  routes,
});
