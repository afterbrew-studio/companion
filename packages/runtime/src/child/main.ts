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
            ...(command.approvals ? { approvals: command.approvals } : {}),
            ...(command.mcpServers ? { mcpServers: command.mcpServers } : {}),
          },
          (ask) => write({ t: 'ask', ask }),
          (requestId) => write({ t: 'ask.resolved', requestId }),
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
      case 'ask.response':
        agent?.answerAsk(command.requestId, command.response.mode);
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

  // A session ends either by the parent closing stdin or by it terminating us.
  // Both have to reach `close()`: an MCP server started here is a child of this
  // process, and one left running would outlive the run and hold this process
  // open with it.
  const shutdown = (): void => agent?.close();
  await new Promise<void>((done) => {
    process.stdin.on('end', () => done());
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        // Registering a handler REPLACES default termination, so the read side
        // has to be released here as well. Left flowing, an open stdin keeps
        // this process alive until the parent's follow-up SIGKILL, which turns
        // every clean stop into a hard one.
        process.stdin.pause();
        done();
      });
    }
  });
  shutdown();
}

// Running this file directly IS the child. The parent spawns it by path, so
// there is no subcommand to dispatch and no argument to get wrong.
await runAgentChild();
