/**
 * Handing the terminal to a prompt while the daemon is running in it.
 *
 * `start` imports companiond into THIS process, so from that point on two things
 * write to the same terminal: the CLI, and the daemon's logger. Inquirer redraws
 * by moving the cursor up the number of lines it last wrote and clearing from
 * there, so a line printed by anyone else moves the cursor without inquirer
 * knowing, the clear lands that many lines short, and the top of the previous
 * frame is left behind. Two log lines during the harness question is how a first
 * run ends up showing it twice.
 *
 * The daemon reaches the terminal through `console` and nothing else (see
 * `createLogger`), so holding console output for the life of a prompt is the
 * whole fix. Held rather than dropped: a warning raised while someone was
 * answering is still a warning, and it arrives as soon as the screen is free.
 */

type ConsoleMethod = 'log' | 'warn' | 'error' | 'info' | 'debug';
const HELD_METHODS: readonly ConsoleMethod[] = ['log', 'warn', 'error', 'info', 'debug'];

/**
 * Bound on what is held. A prompt is answered in seconds, so this is only ever
 * reached by a daemon that is logging in a loop, and dropping the middle of that
 * costs less than an unbounded buffer growing behind a question nobody answered.
 */
const HELD_LIMIT = 500;

export async function withTerminal<T>(prompt: () => Promise<T>): Promise<T> {
  const held: Array<() => void> = [];
  let dropped = 0;
  const original = HELD_METHODS.map((name) => [name, console[name]] as const);
  for (const [name, write] of original) {
    console[name] = (...args: unknown[]): void => {
      if (held.length >= HELD_LIMIT) {
        dropped += 1;
        return;
      }
      held.push(() => write(...args));
    };
  }
  try {
    return await prompt();
  } finally {
    for (const [name, write] of original) console[name] = write;
    for (const replay of held) replay();
    if (dropped > 0) console.warn(`${dropped} further log line(s) were dropped while a prompt was open.`);
  }
}
