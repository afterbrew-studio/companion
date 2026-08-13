import type { RunLane } from '../contract/index.js';

/**
 * Resolving what a run actually starts on, given everything that has an opinion.
 *
 * Kept pure and apart from the orchestrator because this decides the runtime and
 * model of EVERY run: a regression here is invisible until an agent behaves
 * differently for reasons nobody can point at. Each input is a separate
 * argument rather than a lookup so the whole cascade is testable without a
 * database, a machine, or a live gateway.
 */

/** Everything that may name a machine, most authoritative first. */
export interface RunnerInputs {
  /** The caller named one explicitly (a resumed run, a failover retry). */
  readonly explicit?: string | null;
  /** A prepared working directory. It exists on one machine and cannot move. */
  readonly hasPreparedCwd: boolean;
  /** The acting person's lane, when a person is acting. */
  readonly laneRunnerId: string | null;
  /** What placement would pick on its own. */
  readonly placed: string | null;
}

/**
 * A prepared checkout beats the lane on purpose: the worktree only exists on the
 * machine that made it, so honouring a lane here would start the run somewhere
 * the code is not. The lane still decides the RUNTIME in that case, which is the
 * half that actually changes how the agent behaves.
 */
export function resolveRunner(inputs: RunnerInputs): string | null {
  if (inputs.explicit !== undefined) return inputs.explicit;
  if (inputs.hasPreparedCwd) return null;
  return inputs.laneRunnerId ?? inputs.placed;
}

export interface HarnessInputs {
  readonly explicit?: string | null;
  readonly laneHarness: string | null;
  /** Runtimes the chosen machine is actually set up to run. */
  readonly offered: readonly string[];
  /** That machine's own default, used when nothing else applies. */
  readonly machineDefault: string;
}

/**
 * A lane may name a runtime the run's machine does not offer — the lane was
 * chosen for one machine and the run landed on another, or the machine's set
 * changed since. Falling back to the machine's default is the only honest
 * answer: starting a runtime that is not installed there fails the run, and
 * refusing outright would make a stale preference block work indefinitely.
 */
export function resolveHarness(inputs: HarnessInputs): string {
  const wanted = inputs.explicit ?? inputs.laneHarness;
  if (wanted !== null && wanted !== undefined && inputs.offered.includes(wanted)) return wanted;
  return inputs.machineDefault;
}

export interface ModelInputs {
  /** A choice someone just made; honoured as given, never filtered. */
  readonly explicit?: string | null;
  /** The unit of work's standing preference, already narrowed to this machine. */
  readonly preferred: string | null;
  /** Model Router's stage profile, already narrowed to this machine. */
  readonly routed?: string | null;
  /** This lane's pin for this task, already narrowed to this machine. */
  readonly lanePin: string | null;
  /** This lane's default, already narrowed to this machine. */
  readonly laneDefault: string | null;
  /** The instance-wide task pin, already narrowed to this machine. */
  readonly taskPin: string | null;
}

/**
 * Narrower beats broader, and a choice beats every preference.
 *
 * The lane's entries sit between the unit of work and the instance pin: a lane
 * is chosen for a stretch of work and outlives one run, but the person driving
 * that run is closer to it than an instance-wide setting is.
 *
 * null means "nothing decided here", which dispatch answers with the daemon
 * default and then the machine's own.
 */
export function resolveModel(inputs: ModelInputs): string | null {
  return (
    inputs.explicit ??
    inputs.preferred ??
    inputs.routed ??
    inputs.lanePin ??
    inputs.laneDefault ??
    inputs.taskPin ??
    null
  );
}

/** Nothing chosen on either half; used to skip the lookups entirely. */
export function isAutoLane(lane: RunLane): boolean {
  return lane.runnerId === null && lane.harness === null;
}
