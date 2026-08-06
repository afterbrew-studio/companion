import type { AgentRunAccess, AskRequest, Harness, HarnessEvent, HistorySegment } from '@moxxy/companion-types';
import type { HarnessDescriptor, HarnessOption, RunnerCatalog } from '../contract/index.js';
import { CLAUDE_CODE_CAPABILITIES, CLAUDE_MODEL_ALIASES } from '../exec/claude-code.js';
import { CODEX_CAPABILITIES, codexModels } from '../exec/codex.js';
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
  label: 'Moxxy',
  homepage: 'https://moxxy.ai',
  capabilities: MOXXY_CAPABILITIES,
};

export const CLAUDE_CODE_HARNESS: HarnessDescriptor = {
  id: 'claude-code',
  label: 'Claude Code',
  homepage: 'https://claude.com/claude-code',
  capabilities: CLAUDE_CODE_CAPABILITIES,
  models: CLAUDE_MODEL_ALIASES,
};

/**
 * Codex carries no `models` list, which is the one place it differs from Claude
 * Code here. Its model ids are versioned with no stable aliases to pin to, so
 * the fixed list this field exists for would be a snapshot of whatever was
 * current when this build shipped. It answers the question from the machine
 * instead, through `sessionInfo`, which reads the cache Codex keeps.
 */
const CODEX_HARNESS_ID = 'codex';

export const CODEX_HARNESS: HarnessDescriptor = {
  id: CODEX_HARNESS_ID,
  label: 'Codex',
  homepage: 'https://developers.openai.com/codex',
  capabilities: CODEX_CAPABILITIES,
};

/**
 * A machine's catalog when its runtime brings its own models: a constant, so
 * reading it costs nothing. Probing for it would start a process to be told
 * something that cannot change without a new release of that runtime.
 */
export function builtinCatalog(harness: HarnessDescriptor): RunnerCatalog | null {
  // Codex carries no fixed list (see its descriptor) but does keep one on disk,
  // written by the runtime itself. Reading it costs a file read and is the
  // difference between its models being pinnable and the operator being told,
  // wrongly, that this runtime reports nothing. The file read is local to the
  // machine whose adapter owns it.
  const models = harness.models ?? (harness.id === CODEX_HARNESS_ID ? codexModels() : undefined);
  if (models === undefined || models.length === 0) return null;
  return {
    providers: [
      {
        name: harness.id,
        enabled: true,
        ready: true,
        models: models.map((id) => ({ id, contextWindow: null })),
      },
    ],
    defaultModel: null,
    fetchedAt: Date.now(),
  };
}

/** In preference order: moxxy leads because it is the only full capability set. */
const COMPILED_IN: readonly HarnessDescriptor[] = [MOXXY_HARNESS, CLAUDE_CODE_HARNESS, CODEX_HARNESS];

/** What a machine needs to start one run under a registered harness. */
export interface HarnessSpawnRequest {
  readonly runId: string;
  readonly cwd: string;
  readonly access: AgentRunAccess;
  readonly model: string | null;
  /** Somebody is watching, so a per-call approval would actually be answered. */
  readonly attended: boolean;
  /** Whose workspace this run serves; null means only shared credentials apply. */
  readonly workspaceId: string | null;
  readonly onEvent: (event: HarnessEvent) => void;
  readonly onTurnComplete: (turnId?: string) => void;
  readonly onAsk: (ask: AskRequest) => void;
  readonly onAskResolved: (requestId: string) => void;
  readonly onClose: () => void;
}

/**
 * A harness contributed by a module. The three above are imported by name
 * because they were here before the registry was; anything else arrives this
 * way, so shipping a runtime does not mean editing this file.
 */
export interface HarnessRegistration {
  readonly descriptor: HarnessDescriptor;
  /** This machine's answer for it. A runtime with no binary never says absent. */
  detect(): Promise<HarnessDetection>;
  create(request: HarnessSpawnRequest): Promise<Harness>;
  /** A reaped run's transcript, when the harness keeps one of its own. */
  history?(runId: string, before: number | null, limit: number): HistorySegment;
  /**
   * What a REMOTE machine needs in order to start this harness for a run: a
   * resolved model and the ceilings it runs under. Only the module that owns
   * the credentials can answer, which is why it is here rather than in the
   * backend that sends it. Returning null means the machine must resolve its
   * own, which is what happens when the daemon cannot send one safely.
   */
  remotePlan?(
    model: string | null,
    workspaceId: string | null,
    /** The run's access, because what a run may reach is part of what it needs. */
    access: AgentRunAccess,
  ): { readonly spec?: unknown; readonly limits?: unknown; readonly mcpServers?: unknown } | null;
}

const registered = new Map<string, HarnessRegistration>();

export function registerHarness(registration: HarnessRegistration): void {
  registered.set(registration.descriptor.id, registration);
}

/** Disabling a module takes its harness with it, as it takes its permissions. */
export function unregisterHarness(id: string): void {
  registered.delete(id);
}

export function registeredHarness(id: string): HarnessRegistration | null {
  return registered.get(id) ?? null;
}

export function registeredHarnesses(): readonly HarnessRegistration[] {
  return [...registered.values()];
}

/** Every harness this instance can run right now, compiled-in ones first. */
export function allHarnesses(): readonly HarnessDescriptor[] {
  return [...COMPILED_IN, ...[...registered.values()].map((entry) => entry.descriptor)];
}

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
    .map((id) => allHarnesses().find((h) => h.id === id))
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
    const known = allHarnesses().find((h) => h.id === d.id);
    if (!known) return [];
    return [
      { id: d.id, label: known.label, homepage: known.homepage, state: d.state, detail: d.detail, fix: d.fix },
    ];
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
  return allHarnesses().find((h) => h.id === id) ?? claimsNothing(id);
}

function claimsNothing(id: string): HarnessDescriptor {
  return {
    id,
    label: id,
    // Nothing is known about it, and a link that guesses would be worse.
    homepage: '',
    capabilities: {
      approvals: 'policy',
      usage: 'none',
      models: 'none',
      sessionControls: { model: false, provider: false, mode: false, autoApprove: false, commands: false },
    },
  };
}
