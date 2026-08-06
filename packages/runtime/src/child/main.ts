import { takeLines, type RuntimeCommand, type RuntimeFrame } from '../protocol.js';
import { Agent } from './agent.js';

/**
 * The child entry: one process per run, its cwd the run's worktree, speaking
 * newline-delimited JSON on stdin and stdout.
 *
 * It lives in a subprocess rather than in the daemon because modules run
 * in-process with the database handle and full filesystem access, and an agent
 * loop with a shell tool must not be inside the control plane's address space.
 */
export async function runAgentChild(): Promise<void> {
  let agent: Agent | null = null;
  let running: Promise<unknown> = Promise.resolve();
  let buffer = '';

  const write = (frame: RuntimeFrame): void => {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  };

  const handle = (command: RuntimeCommand): void => {
    switch (command.t) {
      case 'start':
        agent = new Agent(
          command.sessionId,
          command.cwd,
          command.access,
          command.spec,
          command.limits,
          (event) => write({ t: 'event', event }),
          {
            ...(command.instructions ? { instructions: command.instructions } : {}),
            ...(command.statePath ? { statePath: command.statePath } : {}),
            ...(command.verifyCommand ? { verifyCommand: command.verifyCommand } : {}),
            ...(command.resultSchema !== undefined ? { resultSchema: command.resultSchema } : {}),
            ...(command.companionApi ? { companionApi: command.companionApi } : {}),
          },
        );
        write({ t: 'ready' });
        break;
      case 'turn': {
        const active = agent;
        if (!active) {
          write({ t: 'turn.end', turnId: command.turnId, ok: false, finalMessage: null, error: 'not started' });
          return;
        }
        // Turns are serialised on purpose: a second prompt written while one is
        // in flight would interleave two tool loops in the same working tree.
        running = running.then(async () => {
          const outcome = await active.runTurn(command);
          write({
            t: 'turn.end',
            turnId: command.turnId,
            ok: outcome.ok,
            finalMessage: outcome.finalMessage,
            ...(outcome.error ? { error: outcome.error } : {}),
          });
        });
        break;
      }
      case 'abort':
        agent?.abort();
        break;
    }
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffer = takeLines(buffer + chunk, (line) => {
      try {
        handle(JSON.parse(line) as RuntimeCommand);
      } catch (err) {
        write({ t: 'fatal', message: err instanceof Error ? err.message : String(err) });
      }
    });
  });

  // The parent closing stdin is how a session ends; anything still running is
  // abandoned rather than left holding the process open.
  await new Promise<void>((done) => process.stdin.on('end', () => done()));
}

// Running this file directly IS the child. The parent spawns it by path, so
// there is no subcommand to dispatch and no argument to get wrong.
await runAgentChild();
