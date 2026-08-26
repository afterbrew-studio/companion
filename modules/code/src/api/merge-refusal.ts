/**
 * Merge is refused at execution, by the instance, whatever the configuration says.
 *
 * The afterbrew fork exists to run an autonomous lane against one repository, and
 * the boundary that lane must not cross is merging its own work. rayf's E-0004
 * states it as "no autonomous path may merge"; ADR-0055 requires the refusal to
 * hold "even if imported configuration, an administrator or model requests one".
 *
 * That wording is the whole design. A pipeline definition is data: it arrives from
 * a save, an import, a Board action, or a model that drafted it. Any check that
 * lives only where pipelines are *written* is a check some other writer routes
 * around -- and every one of those four paths is a different writer. So the
 * authoritative refusal sits at the single point where a step is *run*, which no
 * writer can reach.
 *
 * The write-time checks below are still worth having. They turn "your pipeline
 * will fail at 3am" into "this pipeline was rejected when you saved it". They are
 * ergonomics; `assertStepRunnable` is the control.
 *
 * Deliberately NOT enforced by removing `merge` from the step schema. Pipelines
 * containing a merge step already exist in stored data, and a schema that cannot
 * parse them makes those pipelines invisible rather than refused -- unviewable,
 * uneditable, and impossible to clean up. They parse, they display, they can be
 * deleted. They cannot run.
 */

/** Step kinds this instance will not execute, whatever a definition says. */
export const REFUSED_STEP_KINDS: readonly string[] = ['merge'];

export class StepRefusedError extends Error {
  readonly kind: string;
  readonly statusCode = 400;

  constructor(kind: string, where: string) {
    super(
      `step kind "${kind}" is refused by this instance and cannot ${where}. ` +
        'This is an instance-level policy, not a permission: it cannot be granted, ' +
        'imported, configured or overridden. See ADR-0055 and rayf E-0004.',
    );
    this.name = 'StepRefusedError';
    this.kind = kind;
  }
}

export function isRefusedStepKind(kind: unknown): boolean {
  return typeof kind === 'string' && REFUSED_STEP_KINDS.includes(kind);
}

/**
 * The control. Called from the step registry dispatch, so it runs for every step
 * of every pipeline regardless of how that pipeline came to exist.
 */
export function assertStepRunnable(step: { readonly kind?: unknown }): void {
  if (isRefusedStepKind(step?.kind)) {
    throw new StepRefusedError(String(step.kind), 'be executed');
  }
}

/**
 * Write-time rejection, for saves and imports. Reports every offending step
 * rather than the first: an import of a pipeline with three merge steps should
 * not need three round trips to fix.
 */
export function assertPipelineRunnable(steps: readonly { readonly kind?: unknown }[] | undefined): void {
  const refused = (steps ?? []).filter((step) => isRefusedStepKind(step?.kind));
  if (refused.length > 0) {
    const kinds = [...new Set(refused.map((step) => String(step.kind)))].join(', ');
    throw new StepRefusedError(kinds, 'be saved or imported');
  }
}
