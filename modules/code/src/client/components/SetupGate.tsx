import { useEffect, useState } from 'react';
import { runIntent, type Intent } from '@moxxy/companion-sdk/client';
import { useAuth } from '@companion/module-core/client';
import { useWorkspace } from '@companion/module-workspace/client';
import { EmptyState, Page, PageHeader, PageLoading } from '@moxxy/companion-sdk/ui';
import { codeApi as api } from '../api.js';
import { useWorkspaceReposState } from '../hooks/useWorkspaceRepos.js';

/**
 * Everything GitHub-shaped in Companion needs the same two things first: an
 * account to authenticate as, and a repository to act on. Without them a page
 * is not empty, it is unusable, and an empty list is a poor way to say so: it
 * looks like a state you can wait out.
 *
 * So the pages that cannot work state the prerequisite instead of rendering,
 * and point at the one action that fixes it. The order follows the user's
 * mental model: choose a workspace, connect an identity, then connect a repo.
 *
 * Exported from module-code because code owns both concepts; `plan`, `board`,
 * `refinement`, `planner`, `automations` and `slop` all depend on code and wrap
 * their own pages with it rather than reinventing the check.
 */
export function RequiresRepo({ children, what }: { children: React.ReactNode; what?: string }): React.ReactNode {
  return (
    <RequiresWorkspace what={what}>
      <RequiresGithubAccount what={what}>
        <RepoGate what={what}>{children}</RepoGate>
      </RequiresGithubAccount>
    </RequiresWorkspace>
  );
}

/** The first contextual prerequisite: every operating surface needs a scope. */
export function RequiresWorkspace({
  children,
  what,
}: {
  children: React.ReactNode;
  what?: string;
}): React.ReactNode {
  const { current } = useWorkspace();
  const { can } = useAuth();
  if (current) return children;
  const subject = what ?? 'This page';
  return (
    <Gate
      heading={subject}
      title="Create a workspace first"
      hint={`${subject} works inside a workspace. Create one now; Companion will keep the next prerequisite in context.`}
      intent="new-workspace"
      cta={can('workspaces:create') ? 'Create workspace' : undefined}
    />
  );
}

/**
 * The first half on its own, for the Repositories page: that IS where a repo
 * gets added, so gating it on having one would be a loop. It still cannot work
 * without a credential to browse GitHub with.
 */
export function RequiresGithubAccount({
  children,
  what,
}: {
  children: React.ReactNode;
  what?: string;
}): React.ReactNode {
  const { can } = useAuth();
  const [hasAccount, setHasAccount] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .listGithubAccounts()
      .then(({ accounts }) => alive && setHasAccount(accounts.length > 0))
      // A failed probe must not lock a working instance out of its own pages.
      .catch(() => alive && setHasAccount(true));
    return () => {
      alive = false;
    };
  }, []);

  const subject = what ?? 'This page';

  // Null while the probe is in flight: name the check instead of briefly
  // claiming that an already-connected profile still needs setup.
  if (hasAccount === null) return <GateLoading heading={subject} label="Checking GitHub access…" />;
  if (hasAccount) return children;

  return (
    <Gate
      heading={subject}
      title="Connect a GitHub account first"
      hint={`${subject} needs a GitHub credential to read and act on your repositories. Connect one, then add a repository.`}
      intent="connect-github"
      // Connecting is an admin-shaped act; a viewer is told what is missing
      // rather than sent to a page they cannot use.
      cta={can('github:connect') ? 'Connect GitHub account' : undefined}
    />
  );
}

function RepoGate({ children, what }: { children: React.ReactNode; what?: string }): React.ReactNode {
  const { current } = useWorkspace();
  const { can } = useAuth();
  const { repos, loaded } = useWorkspaceReposState(current?.id);
  const subject = what ?? 'This page';

  if (!current) {
    return <RequiresWorkspace what={subject}>{children}</RequiresWorkspace>;
  }
  // Same rule as the account probe above: an unanswered list is not an empty
  // one, so show the check instead of a false setup instruction.
  if (!loaded) return <GateLoading heading={subject} label="Checking workspace repositories…" />;
  if (repos.length > 0) return children;

  return (
    <Gate
      heading={subject}
      title="Add a repository to get started"
      hint={`${subject} works on the repositories connected to this workspace. There are none yet.`}
      intent="connect-repo"
      cta={can('repos:manage') ? 'Connect repository' : undefined}
    />
  );
}

function GateLoading({ heading, label }: { heading: string; label: string }): JSX.Element {
  return (
    <Page>
      <PageHeader title={heading} />
      <PageLoading label={label} />
    </Page>
  );
}

function Gate({
  heading,
  title,
  hint,
  intent,
  cta,
}: {
  heading: string;
  title: string;
  hint: string;
  intent?: Intent;
  cta?: string;
}): JSX.Element {
  return (
    <Page>
      {/* The header keeps naming the page you asked for, so the gate reads as a
          prerequisite rather than as a different screen. */}
      <PageHeader title={heading} />
      <EmptyState
        title={title}
        hint={hint}
        action={
          intent && cta ? (
            <button className="btn" onClick={() => runIntent(intent)}>{cta}</button>
          ) : undefined
        }
      />
    </Page>
  );
}
