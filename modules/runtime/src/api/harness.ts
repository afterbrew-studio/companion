import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths } from '@moxxy/companion-services';
import type { HarnessRegistration } from '@companion/module-operate/api';
import { RUNTIME_CAPABILITIES, RUNTIME_HARNESS_ID, RuntimeHarness, readRuntimeRunHistory } from '@moxxy/companion-runtime';
import type { RuntimeService } from './runtime-service.js';

/**
 * Where the child bundle is, which differs by how Companion was delivered and
 * is the one thing that will work in a checkout and fail in the image if it is
 * left implicit.
 *
 * In a checkout and in an out-of-tree install the package is on disk beside
 * this module, so Node resolves it. In the CLI bundle this module was inlined
 * and there is no package to resolve, so the child sits next to the bundle that
 * is running, emitted as its own esbuild entry.
 */
export function childPath(): string {
  try {
    return createRequire(import.meta.url).resolve('@moxxy/companion-runtime/child');
  } catch {
    const entry = process.argv[1];
    const sibling = entry ? join(dirname(entry), 'agent.js') : '';
    if (sibling && existsSync(sibling)) return sibling;
    throw new Error(
      'the built-in runtime child bundle was not found: this build carries module-runtime without dist/agent.js',
    );
  }
}

/** Per-run files: the display transcript and the model-facing continuation. */
function runFiles(runId: string): { eventsPath: string; statePath: string } {
  const dir = join(paths.runConfigs(), runId);
  return { eventsPath: join(dir, 'runtime-events.jsonl'), statePath: join(dir, 'runtime-state.json') };
}

/**
 * The registration operate's local backend spawns through.
 *
 * Detection can never say `absent`: this harness IS the process asking, so the
 * only question is whether a model credential is configured. Answering `absent`
 * would drop it from the machine's options for a reason that is not true.
 */
export function harnessRegistration(
  runtime: RuntimeService,
  /** Per-run answers only the orchestrator has: the verify command and the
   *  schema a structured one-shot wants its answer in. */
  extras: (runId: string) => { verifyCommand: string | null; resultSchema: unknown },
): HarnessRegistration {
  return {
    descriptor: {
      id: RUNTIME_HARNESS_ID,
      label: 'Companion',
      homepage: 'https://github.com/moxxy-ai/companion',
      capabilities: RUNTIME_CAPABILITIES,
    },

    detect: async () => {
      if (runtime.ready()) {
        return { id: RUNTIME_HARNESS_ID, version: null, state: 'ready', detail: null, fix: null };
      }
      return {
        id: RUNTIME_HARNESS_ID,
        version: null,
        state: 'installed',
        detail: 'No model provider is configured for it, so a turn would have nothing to run on.',
        // A command, like every other runtime's fix, so the "not ready" hint
        // reads the same whether the runtime is an installed CLI or this one.
        fix: 'companion provider add <name> --kind anthropic --key <key> --model <id>',
      };
    },

    create: async (request) => {
      const spec = runtime.resolve(request.model);
      if (!spec) {
        throw new Error(
          'no model provider is configured for the built-in runtime: add one under Settings, or run companion provider add',
        );
      }
      const files = runFiles(request.runId);
      const { verifyCommand, resultSchema } = extras(request.runId);
      return new RuntimeHarness(
        {
          runId: request.runId,
          cwd: request.cwd,
          access: request.access,
          spec,
          childPath: childPath(),
          limits: runtime.limits(),
          eventsPath: files.eventsPath,
          statePath: files.statePath,
          catalog: runtime.catalog(),
          ...(verifyCommand ? { verifyCommand } : {}),
          ...(resultSchema !== undefined ? { resultSchema } : {}),
        },
        {
          onEvent: request.onEvent,
          onTurnComplete: ({ turnId }) => request.onTurnComplete(turnId),
          onClose: request.onClose,
        },
      );
    },

    history: (runId, before, limit) => readRuntimeRunHistory(runFiles(runId).eventsPath, before, limit),

    /**
     * A remote machine cannot read this instance's provider records, so it is
     * told the resolved model instead. Whether that actually crosses the wire
     * is the backend's call: it carries a credential, and the daemon sends one
     * only over https.
     */
    remotePlan: (model) => {
      const spec = runtime.resolve(model);
      return spec ? { spec, limits: runtime.limits() } : null;
    },
  };
}
