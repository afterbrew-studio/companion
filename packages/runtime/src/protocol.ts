import type { ResolvedModelSpec, RuntimeAccess, RuntimeLimits } from './spec.js';

/**
 * The parent/child wire: newline-delimited JSON in both directions, one frame
 * per line. The same shape Claude Code's `--input-format stream-json` gives us,
 * chosen so the process stays a session rather than one prompt, and so a
 * garbled line can be dropped without stopping the stream.
 *
 * The child emits Companion's own `HarnessEvent` natively, so there is no
 * adapter and no mapping table on this boundary.
 */

/** parent → child */
export type RuntimeCommand =
  | {
      readonly t: 'start';
      readonly sessionId: string;
      readonly cwd: string;
      readonly access: RuntimeAccess;
      readonly spec: ResolvedModelSpec;
      readonly limits: RuntimeLimits;
      /** Extra instructions appended to the built-in system prompt. */
      readonly instructions?: string;
      /** Where the continuation record lives, so a restarted run resumes. */
      readonly statePath?: string;
      /** The repository's own verification command, when one is configured. */
      readonly verifyCommand?: string;
      /** JSON Schema the caller wants the answer in (structured one-shots). */
      readonly resultSchema?: unknown;
      /** Scoped access back to this instance, for platform-operating runs. */
      readonly companionApi?: { readonly baseUrl: string; readonly token: string };
    }
  | { readonly t: 'turn'; readonly turnId: string; readonly prompt: string }
  | { readonly t: 'abort' };

/** child → parent */
export type RuntimeFrame =
  | { readonly t: 'ready' }
  | { readonly t: 'event'; readonly event: unknown }
  | {
      readonly t: 'turn.end';
      readonly turnId: string;
      readonly ok: boolean;
      readonly finalMessage: string | null;
      readonly error?: string;
    }
  | { readonly t: 'fatal'; readonly message: string };

/** Split a growing buffer into complete lines, returning the remainder. */
export function takeLines(buffer: string, onLine: (line: string) => void): string {
  let rest = buffer;
  let newline = rest.indexOf('\n');
  while (newline !== -1) {
    const line = rest.slice(0, newline).trim();
    rest = rest.slice(newline + 1);
    if (line.length > 0) onLine(line);
    newline = rest.indexOf('\n');
  }
  return rest;
}
