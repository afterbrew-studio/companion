/**
 * Open, server-only catalogue of production prompt builders and parsers.
 *
 * Feature modules own their prompts, so they register the exact functions they
 * execute in production. Playground consumes only this narrow seam; it never
 * copies a prompt or parser and therefore cannot give a green result for a
 * test double that has drifted from the real path.
 */

export interface PromptEvaluationAdapterDescriptor {
  readonly id: string;
  readonly moduleId: string;
  readonly label: string;
  /** Production task whose model/lane policy the replay must inherit. */
  readonly task: string;
  /** Bump whenever the prompt contract or parser semantics change. */
  readonly version: number;
}

export interface PromptEvaluationAdapter extends PromptEvaluationAdapterDescriptor {
  /** Validate the frozen fixture and build the exact production prompt. */
  readonly buildPrompt: (fixture: unknown) => string;
  /** Run the exact production extraction + validation boundary. */
  readonly parseResponse: (message: string) => unknown;
}

/** Registry shared by every enabled agent-backed module. */
export class PromptEvaluationCatalog {
  private readonly adapters = new Map<string, PromptEvaluationAdapter>();

  register(adapter: PromptEvaluationAdapter): void {
    assertAdapter(adapter);
    const existing = this.adapters.get(adapter.id);
    if (existing && existing.moduleId !== adapter.moduleId) {
      throw new Error(
        `prompt evaluation adapter '${adapter.id}' is already owned by module '${existing.moduleId}'`,
      );
    }
    // Services may be reconstructed after a runtime disable/enable. Replacing
    // the same owner's functions is intentional and keeps the catalogue live.
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): PromptEvaluationAdapter | null {
    return this.adapters.get(id) ?? null;
  }

  descriptors(): PromptEvaluationAdapterDescriptor[] {
    return [...this.adapters.values()]
      .map(({ id, moduleId, label, task, version }) => ({ id, moduleId, label, task, version }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }
}

function assertAdapter(adapter: PromptEvaluationAdapter): void {
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(adapter.id)) {
    throw new Error(`invalid prompt evaluation adapter id '${adapter.id}'`);
  }
  if (!/^[a-z][a-z0-9-]*$/.test(adapter.moduleId)) {
    throw new Error(`invalid prompt evaluation module id '${adapter.moduleId}'`);
  }
  if (!adapter.label.trim()) throw new Error(`prompt evaluation adapter '${adapter.id}' needs a label`);
  if (!adapter.task.trim()) throw new Error(`prompt evaluation adapter '${adapter.id}' needs a production task`);
  if (!Number.isSafeInteger(adapter.version) || adapter.version < 1) {
    throw new Error(`prompt evaluation adapter '${adapter.id}' needs a positive integer version`);
  }
}
