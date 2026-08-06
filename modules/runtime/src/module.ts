import { defineManifest } from '@moxxy/companion-sdk';

/**
 * module-runtime: the agent runtime Companion owns.
 *
 * Every other harness is somebody else's binary, installed on a machine by a
 * person and signed in interactively. This one is a subprocess of the bundle
 * that is already running, taking its model access from provider records the
 * operator configures here, so an instance can execute agent work with nothing
 * installed and nobody logged into the box.
 *
 * It is not in the slim build. A maintainer on a laptop already has a CLI; this
 * exists for the deployment that does not have a laptop.
 */
export default defineManifest({
  id: 'runtime',
  title: 'Built-in Agent Runtime',
  version: '0.1.0',
  dependsOn: ['core', 'operate'],
  required: false,
  // Model credentials are money and access; an instance should acquire the
  // ability to spend them deliberately, never by upgrading.
  autoInstall: false,
  permissions: ['runtime:read', 'runtime:manage'],
  messages: ['runtime.changed'],
  config: [
    {
      key: 'maxSteps',
      label: 'Model round trips per turn',
      kind: 'number',
      description:
        'How many times one turn may call the model before the loop stops. A tool-using agent with no step ceiling is an unbounded bill.',
      default: 40,
      min: 1,
      max: 500,
    },
    {
      key: 'turnTimeoutMinutes',
      label: 'Turn timeout (minutes)',
      kind: 'number',
      description: 'Wall clock for one turn. The turn is abandoned; the session survives and can be prompted again.',
      default: 30,
      min: 1,
      max: 240,
    },
    {
      key: 'childMemoryMb',
      label: 'Memory ceiling per run (MB)',
      kind: 'number',
      description:
        'Heap ceiling for each agent subprocess. This is what keeps a runaway run from taking the daemon down with it: the loop runs in its own process precisely so this number can exist.',
      default: 1024,
      min: 256,
      max: 16384,
    },
    {
      key: 'commandTimeoutMinutes',
      label: 'Command timeout (minutes)',
      kind: 'number',
      description: 'Wall clock for one command the agent runs (a build, a test suite).',
      default: 10,
      min: 1,
      max: 120,
    },
    {
      key: 'approvalTimeoutMinutes',
      label: 'Approval wait (minutes)',
      kind: 'number',
      description:
        'How long a tool call waits for a person to approve it before being refused. Only attended chats ever ask; unattended work (issue fixes, board tasks, reviews) never stops for a human and is fenced by its worktree instead. Unanswered is always refused, never allowed.',
      default: 10,
      min: 1,
      max: 120,
    },
    {
      key: 'toolOutputChars',
      label: 'Tool output limit (characters)',
      kind: 'number',
      description:
        'How much of any single tool result is handed back to the model. Output past this is dropped with a note, so one noisy command cannot consume the context window.',
      default: 30000,
      min: 2000,
      max: 500000,
    },
  ],
});
