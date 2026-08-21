import { paths, readRegularTextFile } from '@moxxy/companion-services';

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
export type ProfileId = 'slim' | 'full';

/**
 * Modules beyond the always-on core, workspace, execution, code, Today and
 * admin surfaces. Ordered so `dependsOn` is satisfied by installing top to
 * bottom: refinement and planner need plan and board.
 */
export const OPTIONAL_MODULES = [
  'plan',
  'board',
  'refinement',
  'planner',
  'automations',
  'slop',
  'playground',
] as const;

/** `COMPANION_PROFILE` for a non-interactive run; unset or unknown = slim. */
export function profileFromEnv(): ProfileId | null {
  const raw = process.env.COMPANION_PROFILE?.trim().toLowerCase();
  if (raw === 'full') return 'full';
  if (raw === 'slim') return 'slim';
  return null;
}

/**
 * What each optional module needs from the other optional ones. The always-on
 * surfaces are omitted: they are installed before any of this runs.
 */
const NEEDS: Readonly<Record<string, readonly string[]>> = {
  refinement: ['plan', 'board'],
  planner: ['plan', 'board', 'refinement'],
  // The digest itself only needs Plan; the product's primary repository flow
  // additionally needs Board. Treating that as an install dependency keeps a
  // fresh personal instance from presenting a one-click flow it cannot run.
  automations: ['plan', 'board'],
};

/**
 * Close a requested module set over its dependencies, in install order.
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
  return OPTIONAL_MODULES.filter((id) => wanted.has(id));
}

/**
 * Slim is not "nothing optional": Automations makes an instance tell you about
 * itself without being opened and Board makes its issue-to-fix flow durable.
 * `withDependencies` brings both foundations into the recommended install.
 */
const SLIM_MODULES = withDependencies(['automations']);

export const modulesFor = (profile: ProfileId): readonly string[] =>
  profile === 'full' ? OPTIONAL_MODULES : SLIM_MODULES;

export interface ModuleInstallResult {
  readonly id: string;
  readonly error: string | null;
}

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
): Promise<readonly ModuleInstallResult[]> {
  if (!ids.length) return [];
  const token = await waitForToken();
  if (!token) {
    return ids.map((id) => ({ id, error: 'CLI token unavailable; install it later from Modules' }));
  }
  const results: ModuleInstallResult[] = [];
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
      results.push({ id, error: null });
    } catch (err) {
      results.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

/** The daemon mints the token during boot, a moment after it answers /healthz. */
export async function waitForToken(timeoutMs = 15_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const file = paths.cliToken();
    try {
      const token = readRegularTextFile(file, { maxBytes: 4_096, mode: 0o600 }).trim();
      if (token) return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
