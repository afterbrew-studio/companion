/**
 * A run was refused because the machine chosen for it can no longer take it.
 *
 * Distinct from an ordinary failure because it is a scheduling outcome, not a
 * fault of the work: the caller placed a runner, did something slow, and by the
 * time it asked for the run the machine had filled, gone offline, or been
 * disabled. Nothing about the request was wrong, and it is worth trying again.
 *
 * Typed rather than matched on message text so a caller can tell this apart
 * from "this work is invalid" without a pool-wide capacity probe, which answers
 * a different question ("does anywhere have room") than the one that was asked.
 */
export class RunnerUnavailableError extends Error {
  readonly runnerId: string | null;

  constructor(runnerId: string | null, reason: string) {
    super(reason);
    this.name = 'RunnerUnavailableError';
    this.runnerId = runnerId;
  }
}

/** Whether a thrown value is a refusal worth retrying elsewhere. */
export function isRunnerUnavailable(err: unknown): err is RunnerUnavailableError {
  return err instanceof RunnerUnavailableError;
}
