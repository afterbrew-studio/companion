// Brings the augmentations of the modules playground resolves at runtime:
// operate + workspace (hard deps) and code (soft dep — pipeline preview only).
import '@companion/module-core/contract';
import '@companion/module-workspace/contract';
import '@companion/module-operate/contract';
import '@companion/module-code/contract';
import type { PipelineStep, PipelineStepKind, PipelineType, StepFailureMode } from '@companion/module-code/contract';

/**
 * module-playground contract slice — the agent test bench. One permission
 * gates the whole surface: every playground action either spawns a real
 * (read-only-fenced) agent run or inspects run/pipeline configuration.
 * The module owns no tables and broadcasts nothing — the runs it launches
 * already stream through operate's run messages.
 */

declare module '@companion/contracts' {
  interface PermissionRegistry {
    'playground:run': true;
  }
}

// ---------- agent playground -------------------------------------------------------

/** POST /api/playground/run — one read-only-fenced one-shot test run. */
export interface PlaygroundRunRequest {
  /** The test input / instructions for the agent. */
  readonly prompt: string;
  /** Run against this connected repo's clone; omit for a scratch directory. */
  readonly repo?: string;
  /** Preload this skill by inlining its content into the prompt. */
  readonly skill?: string;
  readonly timeoutMs?: number;
}

export interface PlaygroundRunResult {
  readonly runId: string;
  /** The final assistant message (markdown); null = the run produced none
   *  (timeout / dead gateway) — never treat that as success. */
  readonly message: string | null;
}

// ---------- pipeline preview -------------------------------------------------------

/** One step of a pipeline preview: the exact snapshot start() would execute. */
export interface PipelinePreviewStep {
  readonly name: string;
  /** 'unknown' when a library reference no longer resolves. */
  readonly kind: PipelineStepKind | 'unknown';
  readonly onFailure: StepFailureMode | null;
  /** Where the step came from: written inline or referenced from the library. */
  readonly source: 'inline' | 'ref';
  /** The resolved config snapshot; null when the step could not be resolved. */
  readonly config: PipelineStep['config'] | null;
  /** Whether the engine would attempt this step (false after a pre-halt). */
  readonly willRun: boolean;
  /** Why the step will not run, when it won't. */
  readonly note: string | null;
}

/** GET /api/playground/pipeline-preview — evaluation only, zero side effects. */
export interface PipelinePreview {
  readonly pipeline: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly type: PipelineType;
    readonly autoRunOnPrOpen: boolean;
  };
  readonly target: {
    readonly repo: string;
    readonly prNumber: number;
    readonly title: string;
    readonly author: string;
  };
  readonly steps: ReadonlyArray<PipelinePreviewStep>;
}
