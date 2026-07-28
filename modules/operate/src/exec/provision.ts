import { spawn } from 'node:child_process';
import type { ProvisionProviderSpec } from '@moxxy/companion-types';

/**
 * Adding a model provider to a moxxy home, headlessly.
 *
 * The same primitive runs on both kinds of machine: companiond calls it for its
 * own home, and the companion-runner agent calls it for the machine it manages.
 * Whichever side runs it also owns the redaction, so a credential can never
 * leave through an error message.
 */

/** Bound on the stderr kept for an error message; moxxy can be chatty. */
const STDERR_TAIL = 4_000;
/** A CLI that decides to prompt would otherwise hold the request forever. */
const PROVISION_TIMEOUT_MS = 120_000;

/**
 * Run `moxxy provision` against `moxxyHome` to add a provider.
 *
 * Two invariants the code cannot state by itself:
 *  - the spec travels on STDIN, never in argv: it carries an API key, and argv
 *    is readable through `ps` by every user on the machine;
 *  - the flag must be spelled `--spec=-`. moxxy's argv parser reads a bare `-`
 *    as another flag rather than as a value, so `--spec -` hands its string
 *    flag a boolean and the command silently falls through to printing usage.
 *
 * moxxy's stdout is discarded: on success it prints the provisioned record,
 * which can quote the credential back. Its stderr is surfaced on failure with
 * the key scrubbed out.
 */
export function runMoxxyProvision(
  moxxyCliPath: string,
  moxxyHome: string,
  spec: ProvisionProviderSpec,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(moxxyCliPath, ['provision', '--spec=-'], {
      env: { ...process.env, MOXXY_HOME: moxxyHome },
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    let stderr = '';
    let timedOut = false;
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL);
    });
    // The CLI may exit before reading the spec; an EPIPE on this pipe must not
    // reach the process as an unhandled 'error' event.
    child.stdin?.on('error', () => undefined);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, PROVISION_TIMEOUT_MS);

    child.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new Error(
          err.code === 'ENOENT'
            ? `moxxy is not installed on this machine (${moxxyCliPath})`
            : `could not run moxxy provision: ${err.message}`,
        ),
      );
    });

    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`moxxy provision timed out after ${PROVISION_TIMEOUT_MS}ms`));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const detail = scrubSecret(stderr, spec.key).trim().slice(-500);
      reject(new Error(`moxxy provision failed (${signal ?? `exit ${code}`})${detail ? `: ${detail}` : ''}`));
    });

    child.stdin?.end(JSON.stringify(spec));
  });
}

/**
 * Remove a credential from text about to be surfaced or logged. moxxy quotes
 * the spec it was handed back on some failures, and that text reaches an HTTP
 * response; every path that carries a provisioning message out of a process
 * goes through here.
 */
export function scrubSecret(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}
