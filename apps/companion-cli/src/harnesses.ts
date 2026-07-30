/**
 * Settling which agent runtimes this machine will use, on the first run.
 *
 * The daemon answers it, not this process: a harness is installed software, so
 * the question is "what is on this machine", and the daemon already has to know
 * in order to run anything. That also means an instance without the execution
 * module simply never asks, instead of the CLI carrying a catalogue of
 * runtimes it has no way to use.
 *
 * Detection decides the shape of the question. Runtimes that are not installed
 * are absent from the answer, so the list is exactly as long as the machine's
 * real options, and an empty one is the only case that gets sentences.
 */

export interface HarnessOption {
  readonly id: string;
  readonly label: string;
  readonly homepage: string;
  readonly state: 'ready' | 'installed';
  readonly detail: string | null;
  readonly fix: string | null;
}

export interface HarnessOptions {
  readonly options: readonly HarnessOption[];
  readonly selected: readonly string[];
}

const LOCAL_RUNNER_ID = 'runner-local';

export async function readHarnessOptions(
  baseUrl: string,
  token: string,
): Promise<HarnessOptions | null> {
  try {
    const res = await fetch(`${baseUrl}/api/runners/harnesses/${LOCAL_RUNNER_ID}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    // 404 is an instance without the execution module, or a daemon that
    // predates the question. Neither is an error worth printing.
    if (!res.ok) return null;
    return (await res.json()) as HarnessOptions;
  } catch {
    return null;
  }
}

/**
 * The checkbox rows, ticked as detection recommends: ready runtimes on,
 * installed-but-broken ones off with what is wrong beside them.
 *
 * What a row costs goes in its NAME rather than its description, because
 * inquirer only shows a description while its row is highlighted, and "this one
 * is not signed in" is exactly what someone needs before ticking it, not after.
 *
 * A ready row carries the runtime's own site instead, because this is where a
 * name like Moxxy is met for the first time and a product nobody can look up is
 * not a choice anyone can make. The broken row spends that space on the fault,
 * which is the more urgent of the two.
 */
export function harnessChoices(
  options: readonly HarnessOption[],
): ReadonlyArray<{ value: string; name: string; description?: string; checked: boolean }> {
  return options.map((option) => ({
    value: option.id,
    name:
      option.state === 'ready'
        ? `${option.label}  (${option.homepage})`
        : `${option.label}  (${option.detail ?? 'not ready'})`,
    description: option.fix ? `Fix it with: ${option.fix}` : undefined,
    checked: option.state === 'ready',
  }));
}

/** What to say when the machine can run nothing. The only case needing words. */
export const NOTHING_INSTALLED = [
  'No agent runtime is installed on this machine, so agent work cannot run yet.',
  'Install one and Companion will pick it up:',
  '',
  '  Moxxy (https://moxxy.ai)',
  '    npm i -g @moxxy/cli                then: moxxy provision',
  '  Claude Code (https://claude.com/claude-code)',
  '    npm i -g @anthropic-ai/claude-code then: claude auth login',
  '  Codex (https://developers.openai.com/codex)',
  '    npm i -g @openai/codex             then: codex login',
].join('\n');

export async function saveHarnesses(
  baseUrl: string,
  token: string,
  harnesses: readonly string[],
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/runners/${LOCAL_RUNNER_ID}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ harnesses }),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
}
