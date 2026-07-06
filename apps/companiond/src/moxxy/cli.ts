import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * moxxy is an external runtime: Companion never bundles it. We resolve the
 * installed CLI and gate on its version; anything else is a setup error the
 * UI surfaces, never something we silently work around.
 */
export interface MoxxyCli {
  readonly path: string;
  readonly version: string;
  readonly compatible: boolean;
}

/** Lowest moxxy release whose gateway surface Companion is written against. */
export const MIN_MOXXY_VERSION = '0.26.0';

export async function detectMoxxyCli(moxxyHome: string, explicitPath?: string): Promise<MoxxyCli | null> {
  const candidate = explicitPath ?? 'moxxy';
  try {
    const { stdout } = await execFileP(candidate, ['--version'], {
      timeout: 15_000,
      env: probeEnv(moxxyHome),
    });
    const version = parseVersion(stdout);
    if (!version) return null;
    const path =
      explicitPath ?? (await execFileP('which', ['moxxy']).then((r) => r.stdout.trim()).catch(() => 'moxxy'));
    return { path, version, compatible: compareSemver(version, MIN_MOXXY_VERSION) >= 0 };
  } catch {
    return null;
  }
}

/** `moxxy --version` prints a banner; the version is on its own line. */
function parseVersion(stdout: string): string | null {
  const match = stdout.match(/moxxy\s+(\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Env for probing the CLI. MOXXY_HOME deliberately points at Companion's home:
 * a bare `moxxy` invocation must NEVER touch the user's daily ~/.moxxy (a
 * banner probe once booted a live gateway against it during development).
 */
function probeEnv(moxxyHome: string): NodeJS.ProcessEnv {
  return { ...process.env, MOXXY_HOME: moxxyHome };
}
