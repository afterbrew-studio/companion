import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '@moxxy/companion-services';
import type { ResolvedModelSpec } from '@moxxy/companion-runtime';
import { log } from './log.js';

/**
 * Runner configuration — env only, no config file. `bootstrap.ts` already
 * pinned COMPANION_HOME to the runner home, so every reused `paths.*` helper
 * (moxxy home, sockets, repos, worktrees, scratch, run configs, sessions)
 * resolves under it.
 */
export interface RunnerConfig {
  /** The runner's data root (COMPANION_RUNNER_HOME, default ~/.companion-runner). */
  readonly home: string;
  readonly host: string;
  readonly port: number;
  /** Max concurrently live gateway processes. */
  readonly maxRuns: number;
  /** Bearer token companiond must present on every request. */
  readonly token: string;
  /**
   * Optional per-machine GitHub PAT override. When null (the default),
   * Companion supplies its own configured credential with each network git
   * call, so no GitHub setup is needed on this box.
   */
  readonly githubToken: string | null;
  /**
   * This machine's OWN model, for the built-in runtime. Null means it takes
   * whatever an https Companion sends with the run; with neither, a run under
   * that runtime is refused here rather than started and left unable to answer.
   *
   * Model credentials belonging to the machine is the same ownership rule every
   * other runtime on a runner follows, and the reason it matters more here is
   * that the runner endpoint is plain http unless the operator made it https.
   */
  readonly provider: ResolvedModelSpec | null;
}

const DEFAULT_PORT = 8920;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_MAX_RUNS = 3;

export function loadRunnerConfig(): RunnerConfig {
  for (const dir of [
    paths.root(),
    paths.moxxyHome(),
    paths.sockets(),
    paths.repos(),
    paths.worktrees(),
    paths.scratch(),
    paths.runConfigs(),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  return {
    home: paths.root(),
    host: process.env.COMPANION_RUNNER_HOST?.trim() || DEFAULT_HOST,
    port: numberFrom(process.env.COMPANION_RUNNER_PORT) ?? DEFAULT_PORT,
    maxRuns: numberFrom(process.env.COMPANION_RUNNER_MAX_RUNS) ?? DEFAULT_MAX_RUNS,
    token: resolveToken(paths.root()),
    githubToken: process.env.COMPANION_RUNNER_GITHUB_TOKEN?.trim() || null,
    provider: localProvider(),
  };
}

/**
 * A model configured on this machine, from four environment variables. Enough
 * to describe any of the built-in provider kinds, and deliberately not a config
 * file: a runner is meant to be a container, and a container is configured by
 * environment and mounted secrets.
 */
function localProvider(): ResolvedModelSpec | null {
  const kind = process.env.COMPANION_RUNNER_PROVIDER_KIND?.trim();
  const model = process.env.COMPANION_RUNNER_MODEL?.trim();
  if (!kind || !model) return null;
  return {
    providerId: process.env.COMPANION_RUNNER_PROVIDER_ID?.trim() || kind,
    kind,
    baseUrl: process.env.COMPANION_RUNNER_PROVIDER_URL?.trim() || null,
    apiKey: process.env.COMPANION_RUNNER_PROVIDER_KEY?.trim() || null,
    headers: {},
    query: {},
    model,
    contextWindow: numberFrom(process.env.COMPANION_RUNNER_CONTEXT_WINDOW) ?? null,
    apiVersion: process.env.COMPANION_RUNNER_PROVIDER_API_VERSION?.trim() || null,
    sampling: {},
    providerOptions: {},
    factoryOptions: {},
  };
}

/**
 * Token precedence: COMPANION_RUNNER_TOKEN > <home>/token > generate.
 * A generated token is persisted (so restarts keep it) and logged ONCE so the
 * operator can paste it into companiond's runner registration.
 */
function resolveToken(home: string): string {
  const fromEnv = process.env.COMPANION_RUNNER_TOKEN?.trim();
  if (fromEnv) return fromEnv;

  const file = join(home, 'token');
  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf8').trim();
    if (stored) return stored;
  }

  const token = randomBytes(32).toString('hex');
  writeFileSync(file, token + '\n', { mode: 0o600 });
  log.info(`COMPANION_RUNNER_TOKEN not set — generated one (saved to ${file}): ${token}`);
  return token;
}

function numberFrom(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
