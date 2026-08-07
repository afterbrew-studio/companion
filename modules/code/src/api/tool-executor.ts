import type { ServiceMap } from '@moxxy/companion-contracts';
import type { ToolMachine } from '@companion/module-operate/contract';
import type { IntegrationExecutor } from '@companion/module-integrations/provider';

/** The machine registry, as its owner publishes it, never widened here. */
type Runners = ServiceMap['operate']['runners'];

/** Default ceiling for a provider CLI that names none of its own. */
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * A machine that has a provider's CLI, as the integrations layer consumes it.
 *
 * The adapter is deliberately thin: it turns "this machine has `cr`" into "run
 * `cr` there", and nothing about a provider reaches the runner registry or vice
 * versa. Both halves already exist: machines with detected tools on one side,
 * providers that declare what they need on the other, and this is the joint.
 */
export function toolExecutor(runners: Runners, machine: ToolMachine): IntegrationExecutor {
  return {
    runnerId: machine.runnerId,
    machine: machine.name,
    binary: machine.binary,
    version: machine.version,
    scratch: (key) => runners.backend(machine.runnerId).scratchDir(key),
    at: (cwd) => ({
      machine: machine.name,
      run: async (args, options) => {
        const result = await runners.backend(machine.runnerId).runTool({
          cwd,
          // The executable that was actually found, not the candidate list
          // again: a machine with both installed must run the one it reported,
          // or the version the operator saw is not the version that ran.
          binaries: [machine.binary],
          args,
          timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ...(options?.signal ? { signal: options.signal } : {}),
          ...(options?.onLine ? { onLine: options.onLine } : {}),
          ...(options?.maxStdout !== undefined ? { maxStdout: options.maxStdout } : {}),
          ...(options?.maxStderr !== undefined ? { maxStderr: options.maxStderr } : {}),
          ...(options?.env ? { env: options.env } : {}),
        });
        if (!result) {
          throw new Error(
            `${machine.name} runs a runner agent too old to run developer tools; update companion-runner there`,
          );
        }
        return {
          binary: result.binary,
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          missing: result.missing,
        };
      },
    }),
  };
}
