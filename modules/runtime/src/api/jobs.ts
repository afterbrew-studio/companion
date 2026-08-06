import { readFileSync } from 'node:fs';
import { defineJobs } from '@moxxy/companion-sdk/server';
import { paths } from '@moxxy/companion-services';
import { registerHarness, unregisterHarness } from '@companion/module-operate/api';
import { RUNTIME_HARNESS_ID } from '@moxxy/companion-runtime';
import { harnessRegistration } from './harness.js';
import type { DeclaredProvider } from './runtime-service.js';
import '../contract/index.js';

/**
 * Enabling this module is what makes the built-in runtime a choice on this
 * instance; disabling it takes the harness back out of the registry, the same
 * way a disabled module's permissions leave the grid.
 */
export default defineJobs({
  onEnable: async (ctx) => {
    const runtime = ctx.services.get('runtime');
    const operate = ctx.services.get('operate');
    // Declared providers are adopted before anything can ask whether this
    // machine is ready, so a container that shipped with its providers is ready
    // on its first boot rather than after somebody clicks.
    const declared = declaredProviders();
    if (declared.length > 0) runtime.adopt(declared);
    registerHarness(harnessRegistration(runtime, (runId) => operate.orchestrator.runExtras(runId)));
    // Detection was cached before this harness existed, and a machine that has
    // never chosen one adopts whatever is ready. Without this, enabling the
    // module leaves the box reporting the runtimes it had a minute ago.
    await operate.runners.refreshRuntimes();
  },
  onDisable: () => {
    unregisterHarness(RUNTIME_HARNESS_ID);
  },
});

/**
 * Providers declared in `$COMPANION_HOME/companiond.json`. A hosted deployment
 * is only reproducible if its providers ship with the container, and the key
 * arrives through `apiKeyEnv` so it can be a mounted secret rather than a value
 * committed into a file.
 */
function declaredProviders(): readonly DeclaredProvider[] {
  try {
    const parsed = JSON.parse(readFileSync(paths.daemonConfig(), 'utf8')) as {
      modelProviders?: readonly DeclaredProvider[];
    };
    return parsed.modelProviders ?? [];
  } catch {
    return [];
  }
}
