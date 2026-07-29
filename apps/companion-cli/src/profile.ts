import { existsSync, readFileSync } from 'node:fs';
import { paths } from '@moxxy/companion-services';

/**
 * Which modules a fresh instance turns on.
 *
 * The published package carries every module, because a tarball cannot be
 * re-picked after the fact: `COMPANION_PROFILE=full npx @moxxy/companion` used
 * to do nothing at all, since the module set was compiled in and fixed at
 * `slim`. So the choice moved to where it can actually be made, first run, and
 * means "install these now" rather than "ship these".
 *
 * Nothing is lost by choosing wrong. Everything is installable later from the
 * Modules page or `companion module install <id>`; a profile only decides where
 * you start.
 */
export type ProfileId = 'slim' | 'full' | 'custom';

/**
 * Modules beyond the always-on five. Ordered so `dependsOn` is satisfied by
 * installing top to bottom: refinement and planner need plan and board.
 */
export const OPTIONAL_MODULES: ReadonlyArray<{ id: string; label: string; hint: string }> = [
  { id: 'plan', label: 'Plan', hint: 'Specifications and documentation, drafted by agents.' },
  { id: 'board', label: 'Task board', hint: 'Work items with an agent lifecycle.' },
  { id: 'refinement', label: 'Product refinement', hint: 'Turn rough ideas into shaped work.' },
  { id: 'planner', label: 'Ideas', hint: 'Guided planning sessions across the board.' },
  { id: 'automations', label: 'Automations', hint: 'Scheduled and reactive agent work.' },
  { id: 'slop', label: 'Slop detection', hint: 'Flags low-quality agent output.' },
  { id: 'playground', label: 'Playground', hint: 'A bench for testing agents, skills and pipelines.' },
];

export const PROFILE_CHOICES: ReadonlyArray<{ value: ProfileId; name: string; description: string }> = [
  {
    value: 'slim',
    name: 'Slim (recommended)',
    description: 'Repositories, agent runs and administration. Everything else stays one click away.',
  },
  {
    value: 'full',
    name: 'Full',
    description: 'Adds planning, the task board, refinement, ideas, automations, slop detection and the playground.',
  },
  { value: 'custom', name: 'Custom', description: 'Pick the optional modules yourself.' },
];

/** `COMPANION_PROFILE` for a non-interactive run; unset or unknown = slim. */
export function profileFromEnv(): ProfileId | null {
  const raw = process.env.COMPANION_PROFILE?.trim().toLowerCase();
  if (raw === 'full') return 'full';
  if (raw === 'slim') return 'slim';
  return null;
}

/**
 * What each optional module needs from the other optional ones. The always-on
 * five are omitted: they are installed before any of this runs.
 */
const NEEDS: Readonly<Record<string, readonly string[]>> = {
  refinement: ['plan', 'board'],
  planner: ['plan', 'board', 'refinement'],
  automations: ['plan'],
};

/**
 * Close a custom selection over its dependencies, in install order.
 *
 * Picking "Ideas" without Plan and the board would fail at install with "enable
 * dependency first", which is a true error and a useless one: the answer is
 * always to add them. So they are added, and the caller reports what it did.
 */
export function withDependencies(ids: readonly string[]): readonly string[] {
  const wanted = new Set(ids);
  for (;;) {
    const before = wanted.size;
    for (const id of [...wanted]) for (const dep of NEEDS[id] ?? []) wanted.add(dep);
    if (wanted.size === before) break;
  }
  // OPTIONAL_MODULES is already in dependsOn order, so filtering preserves it.
  return OPTIONAL_MODULES.filter((m) => wanted.has(m.id)).map((m) => m.id);
}

/**
 * The labels ticking one module would drag in with it, transitively.
 *
 * Derived from `withDependencies` rather than read off `NEEDS`, so the list the
 * chooser shows and the set the installer builds cannot disagree: a dependency
 * added to one is a dependency shown by the other.
 */
export function requires(id: string): readonly string[] {
  const labels = new Map(OPTIONAL_MODULES.map((m) => [m.id, m.label]));
  return withDependencies([id])
    .filter((dep) => dep !== id)
    .map((dep) => labels.get(dep) ?? dep);
}

export const modulesFor = (profile: ProfileId): readonly string[] =>
  profile === 'full' ? OPTIONAL_MODULES.map((m) => m.id) : [];

/**
 * Install the chosen modules against the freshly started daemon.
 *
 * Sequential on purpose: each install runs migrations and activates services,
 * and `dependsOn` is only satisfied once the dependency is enabled. Failures are
 * reported and skipped rather than aborting, because a half-configured instance
 * you can finish from the UI beats a boot that stops halfway with no explanation.
 */
export async function installModules(
  baseUrl: string,
  ids: readonly string[],
  out: (line: string) => void,
): Promise<void> {
  if (!ids.length) return;
  const token = await waitForToken();
  if (!token) {
    out(`Could not read the CLI token, so ${ids.join(', ')} were not installed.`);
    out(`Install them from the Modules page, or run: companion module install ${ids[0]}`);
    return;
  }
  for (const id of ids) {
    try {
      const res = await fetch(`${baseUrl}/api/modules/${id}/install`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      });
      // A 404 here is not "install failed", it is "this build does not contain
      // it", and saying so is the difference between a fixable answer and a
      // wall. It means the artifact was built at a narrower profile than the
      // one that offered these choices.
      if (res.status === 404) throw new Error('this build does not contain it, so it cannot be installed');
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
      out(`  enabled ${id}`);
    } catch (err) {
      out(`  could not enable ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** The daemon mints the token during boot, a moment after it answers /healthz. */
async function waitForToken(timeoutMs = 15_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const file = paths.cliToken();
    if (existsSync(file)) {
      const token = readFileSync(file, 'utf8').trim();
      if (token) return token;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
