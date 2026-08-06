import { defineClientModule } from '@moxxy/companion-sdk/client';
// Carries this module's contract augmentations (Permission/ServiceMap/messages)
// into every compilation that loads the client slice.
import '../contract/index.js';
import manifest from '../module.js';
import { actions, nav, sections } from './nav.js';
import { routes } from './routes.js';
import { slots } from './slots.js';
import { onboarding } from './onboarding.js';

/**
 * The `/client` barrel — module-code's web surface: Workspace and Code & review
 * groups, their routes, the GitHub-flavored widget set, and the pieces
 * downstream modules reach by name.
 */

export * from './widgets.js';
export { useWorkspaceRepos, useWorkspaceReposState } from './hooks/useWorkspaceRepos.js';
export { CommentsSection } from './components/Comments.js';
export { AccountPicker } from './components/AccountPicker.js';
export { RepoAccountPicker } from './components/RepoAccountPicker.js';
export { BranchPicker } from './components/BranchPicker.js';
export { RepoUnavailableRow } from './components/RepoUnavailableRow.js';
/** The GitHub prerequisite gate, for modules that also need a repository. */
export { RequiresRepo, RequiresGithubAccount } from './components/SetupGate.js';
/** The quality card, so a `quality.panels` contributor renders identically. */
export { QualityStat } from './components/QualityStat.js';
export { codeApi } from './api.js';

export default defineClientModule({
  manifest,
  sections,
  nav,
  routes,
  onboarding,
  slots,
  quickActions: actions,
});

/** Published for other modules' bulk actions on the PR list. */
export { usePrSelection } from './pr-selection.js';
