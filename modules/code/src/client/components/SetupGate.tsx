import { useEffect, useState } from 'react';
import { useAuth } from '@companion/module-core/client';
import { useWorkspace } from '@companion/module-workspace/client';
import { EmptyState, Page, PageHeader } from '@moxxy/companion-sdk/ui';
import { codeApi as api } from '../api.js';
import { useWorkspaceReposState } from '../hooks/useWorkspaceRepos.js';

/**
 * Everything GitHub-shaped in Companion needs the same two things first: an
 * account to authenticate as, and a repository to act on. Without them a page
 * is not empty, it is unusable, and an empty list is a poor way to say so: it
 * looks like a state you can wait out.
 *
 * So the pages that cannot work state the prerequisite instead of rendering,
 * and point at the one screen that fixes it. The order matters and is the order
 * a person hits it: connecting a repository requires an account to see it with,
 * so an instance with no accounts is sent there first.
 *
 * Exported from module-code because code owns both concepts; `plan`, `board`,
 * `refinement`, `planner`, `automations` and `slop` all depend on code and wrap
 * their own pages with it rather than reinventing the check.
 */
export function RequiresRepo({ children, what }: { children: React.ReactNode; what?: string }): React.ReactNode {
  return (
    <RequiresGithubAccount what={what}>
      <RepoGate what={what}>{children}</RepoGate>
    </RequiresGithubAccount>
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

  // Null while the probe is in flight: flashing "connect an account" at someone
  // who has one is worse than showing nothing for a beat.
  if (hasAccount === null) return null;
  if (hasAccount) return children;

  return (
    <Gate
      heading={subject}
      title="Connect a GitHub account first"
      hint={`${subject} needs a GitHub credential to read and act on your repositories. Connect one, then add a repository.`}
      href="#/github"
      // Connecting is an admin-shaped act; a viewer is told what is missing
      // rather than sent to a page they cannot use.
      cta={can('github:connect') ? 'Go to GitHub accounts' : undefined}
    />
  );
}

function RepoGate({ children, what }: { children: React.ReactNode; what?: string }): React.ReactNode {
  const { current } = useWorkspace();
  const { can } = useAuth();
  const { repos, loaded } = useWorkspaceReposState(current?.id);
  const subject = what ?? 'This page';

  if (!current) {
    return (
      <Gate
        heading={subject}
        title="No workspace yet"
        hint={`${subject} works inside a workspace. Create one from the sidebar switcher.`}
      />
    );
  }
  // Same rule as the account probe above: an unanswered list is not an empty
  // one, and flashing "add a repository" at someone who has twenty is worse
  // than showing nothing for a beat.
  if (!loaded) return null;
  if (repos.length > 0) return children;

  return (
    <Gate
      heading={subject}
      title="Add a repository to get started"
      hint={`${subject} works on the repositories connected to this workspace. There are none yet.`}
      href="#/repos"
      cta={can('repos:manage') ? 'Go to Repositories' : undefined}
    />
  );
}

function Gate({
  heading,
  title,
  hint,
  href,
  cta,
}: {
  heading: string;
  title: string;
  hint: string;
  href?: string;
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
          href && cta ? (
            <a className="btn" href={href}>
              {cta}
            </a>
          ) : undefined
        }
      />
    </Page>
  );
}
