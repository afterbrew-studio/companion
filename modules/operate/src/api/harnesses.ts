import type { HarnessDescriptor, HarnessOption, RunnerCatalog } from '../contract/index.js';
import { CLAUDE_CODE_CAPABILITIES, CLAUDE_MODEL_ALIASES } from '../exec/claude-code.js';
import type { HarnessDetection } from '../exec/harness-detect.js';
import { MOXXY_CAPABILITIES } from '../exec/gateway-client.js';

/**
 * The agent runtimes this build knows how to run, each carrying the capability
 * declaration its own implementation makes. Nothing here restates what a
 * harness can do: a second table would drift from the client that implements it
 * on the first release where the two disagree.
 */
export const MOXXY_HARNESS: HarnessDescriptor = {
  id: 'moxxy',
  label: 'moxxy',
  capabilities: MOXXY_CAPABILITIES,
};

export const CLAUDE_CODE_HARNESS: HarnessDescriptor = {
  id: 'claude-code',
  label: 'Claude Code',
  capabilities: CLAUDE_CODE_CAPABILITIES,
  models: CLAUDE_MODEL_ALIASES,
};

/**
 * A machine's catalog when its runtime brings its own models: a constant, so
 * reading it costs nothing. Probing for it would start a process to be told
 * something that cannot change without a new release of that runtime.
 */
export function builtinCatalog(harness: HarnessDescriptor): RunnerCatalog | null {
  if (harness.models === undefined) return null;
  return {
    providers: [
      {
        name: harness.id,
        enabled: true,
        ready: true,
        models: harness.models.map((id) => ({ id, contextWindow: null })),
      },
    ],
    defaultModel: null,
    fetchedAt: Date.now(),
  };
}

/** In preference order: moxxy leads because it is the only full capability set. */
export const HARNESSES: readonly HarnessDescriptor[] = [MOXXY_HARNESS, CLAUDE_CODE_HARNESS];

/**
 * A machine's chosen set, as descriptors.
 *
 * Never empty and never a harness this build cannot run: a stored id from a
 * build that had it would otherwise make the machine advertise something no
 * placement could execute. Nothing stored means nothing was ever chosen, which
 * is moxxy, because that is what every machine ran before the choice existed.
 */
export function harnessSet(stored: readonly string[]): readonly HarnessDescriptor[] {
  const known = stored
    .map((id) => HARNESSES.find((h) => h.id === id))
    .filter((h): h is HarnessDescriptor => h !== undefined);
  return known.length > 0 ? known : [MOXXY_HARNESS];
}

/**
 * What was detected on a machine, as the choices it should be offered.
 *
 * A runtime that is not installed is dropped rather than listed as
 * unavailable: advertising software the operator has not installed turns a
 * setup step into a catalogue, and the list is meant to be exactly as long as
 * that machine's real options. A detection this build cannot run is dropped for
 * the same reason it could not be chosen.
 */
export function offeredHarnesses(detected: readonly HarnessDetection[]): HarnessOption[] {
  return detected.flatMap((d): HarnessOption[] => {
    if (d.state === 'absent') return [];
    const known = HARNESSES.find((h) => h.id === d.id);
    if (!known) return [];
    return [{ id: d.id, label: known.label, state: d.state, detail: d.detail, fix: d.fix }];
  });
}

/**
 * What a recorded harness id means here.
 *
 * An id this build does not implement can only come from a run started under a
 * harness since removed, and the honest answer for it is a declaration that
 * claims nothing: it will raise no approval, report no usage and offer no
 * models, all of which are true of a harness that is not here. Substituting
 * moxxy's answers would make a dead run look like a live one.
 */
export function describeHarness(id: string): HarnessDescriptor {
  return HARNESSES.find((h) => h.id === id) ?? claimsNothing(id);
}

function claimsNothing(id: string): HarnessDescriptor {
  return {
    id,
    label: id,
    capabilities: {
      approvals: 'policy',
      usage: 'none',
      models: 'none',
      sessionControls: { model: false, provider: false, mode: false, autoApprove: false, commands: false },
    },
  };
}
