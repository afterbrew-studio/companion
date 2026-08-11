import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * MUST be the first import of the entrypoint.
 *
 * The runner reuses companiond's config/gateway-pool/checkouts/history modules
 * verbatim; they all resolve their data root through `companionHome()`, which
 * reads `process.env.COMPANION_HOME` lazily at call time. Pinning that env var
 * to the runner's OWN home here — before any of those modules run — gives the
 * agent a fully separate data root, so a companiond on the same box is never
 * touched.
 */
process.umask(0o077);
process.env.COMPANION_HOME =
  process.env.COMPANION_RUNNER_HOME ?? join(homedir(), '.companion-runner');
