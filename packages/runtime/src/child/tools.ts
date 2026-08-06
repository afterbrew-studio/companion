import { execFile, spawn } from 'node:child_process';
import { readdirSync, readFileSync, mkdirSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { RuntimeAccess, RuntimeLimits } from '../spec.js';

/**
 * The predefined tool set, gated by the run's access. The gate is the tool list
 * itself rather than a check inside each tool: a tool the model was never shown
 * cannot be talked into running.
 *
 * Two absences are deliberate. There is no GitHub credential and no network git
 * here: every network git operation resolves its credential on the daemon,
 * which is where the write policy, the protected-branch gate and the audit
 * entry live, and handing the agent a token routes around all three. And no
 * repository instruction file is read, because a checked-out `AGENTS.md` is
 * untrusted input rather than configuration.
 */

/**
 * Git commands the agent must not run through a shell, each for its own reason,
 * because "no git" would be both wrong and unhelpful: committing is local and
 * fine, and the useful read-only forms are typed tools below.
 *
 * The fence for the network ones is really the worktree, which holds no
 * credential; these refusals exist so the model is told WHY rather than left
 * to interpret an authentication failure. The local ones are refused because
 * they invalidate state Companion recorded when it prepared this run: the
 * branch on the run row, the worktree registry the storage sweep reads, and the
 * remote a later push resolves against.
 */
const DENIED_COMMANDS: ReadonlyArray<{ readonly rule: RegExp; readonly why: string }> = [
  { rule: /^\s*git\s+push\b/, why: 'Companion pushes after a person reviews the change; this worktree holds no credential.' },
  { rule: /^\s*git\s+(fetch|pull)\b/, why: 'Companion owns network git and prepared this worktree at the base it wants.' },
  { rule: /^\s*git\s+remote\b/, why: 'the remote decides where a later push lands, so it is not the agent\'s to change.' },
  { rule: /^\s*git\s+worktree\b/, why: 'worktrees are allocated by Companion and swept on retention; a second one here is invisible to both.' },
  { rule: /^\s*git\s+(checkout|switch)\b/, why: 'this run is recorded against one branch; use git_restore to discard changes to a file.' },
];

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '.turbo', 'coverage']);

export interface ToolContext {
  readonly cwd: string;
  readonly limits: RuntimeLimits;
  /** The repository's own verification command, when one is configured. */
  readonly verifyCommand?: string;
  /**
   * A JSON Schema the caller wants the answer in. Present for the structured
   * one-shots that most of Companion is built out of, absent for a chat.
   */
  readonly resultSchema?: unknown;
  /** Where a `trusted-assistant` run reaches this instance's own API. */
  readonly companionApi?: { readonly baseUrl: string; readonly token: string };
  /**
   * Tools contributed by the MCP servers this run was given. Already namespaced
   * and already filtered by the daemon's policy, so the only decision left here
   * is that they are external and therefore always behind the approval guard.
   */
  readonly mcpTools?: ToolSet;
  /** Captures the structured answer so it can be returned as the final message. */
  onResult?(value: unknown): void;
  /**
   * Ask a person before a call that changes something. Absent for unattended
   * work, whose fence is the run's access and its credential-less worktree
   * rather than somebody watching.
   */
  approve?(tool: string, input: unknown): Promise<{ allowed: boolean; expired?: boolean }>;
}

/**
 * Wrap the tools that CHANGE something so a person can stop them one at a time.
 * Applied to the set rather than written into each definition: a tool added
 * later is covered by where it is registered, not by remembering to guard it.
 */
function guarded(tools: ToolSet, ctx: ToolContext): ToolSet {
  const approve = ctx.approve;
  if (!approve) return tools;
  for (const [name, definition] of Object.entries(tools)) {
    // The tool object is REPLACED IN PLACE rather than spread into a new one.
    // `tool()` returns a branded value the SDK checks before it will execute
    // anything, and a spread produces a plain object that looks the same and is
    // silently never called: the model's tool call comes back with no result.
    const holder = definition as { execute?: (input: never, options: never) => unknown };
    const original = holder.execute;
    if (typeof original !== 'function') continue;
    holder.execute = async (input: never, options: never) => {
      const decision = await approve(name, input);
      // RETURNED, not thrown. A thrown refusal reaches the model as "the tool
      // failed" with the reason stripped by the SDK, and a denial the model
      // cannot read is one it cannot explain or work around. As a result it is
      // text the model always sees, so it can say what it was told and propose
      // something else. The call still did nothing, which is the point.
      if (!decision.allowed) {
        return decision.expired
          ? `refused: nobody answered the approval for this ${name} call in time, so it was not run`
          : `refused: a reviewer denied this ${name} call, so it was not run`;
      }
      return original(input, options);
    };
  }
  return tools;
}

/** Resolve a model-supplied path inside the working tree, or refuse. */
function inside(cwd: string, path: string): string {
  const target = resolve(cwd, path);
  const rel = relative(cwd, target);
  if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || resolve(rel) === rel) {
    throw new Error(`path '${path}' is outside the working directory`);
  }
  return target;
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… ${text.length - limit} more characters were dropped`;
}

function walk(root: string, dir: string, out: string[], limit: number): void {
  if (out.length >= limit) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, full, out, limit);
    else out.push(relative(root, full));
  }
}

/**
 * Glob to regular expression, in ONE pass over the wildcards.
 *
 * The obvious version expands `**` to a placeholder, then `*`, then the
 * placeholder back. Whatever character it borrows is a character a real glob
 * may contain, and the one this borrowed ended up written into the source as a
 * literal NUL, which made git treat a TypeScript file as binary. Replacing
 * every wildcard in a single traversal borrows nothing.
 */
function matches(path: string, glob: string | undefined): boolean {
  if (!glob) return true;
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*|\*|\?/g, (token) => (token === '**' ? '.*' : token === '*' ? '[^/]*' : '.'));
  return new RegExp(`^${pattern}$`).test(path);
}

const readOnlyTools = (ctx: ToolContext): ToolSet => ({
  read_file: tool({
    description: 'Read a UTF-8 file from the working directory, optionally a line range.',
    inputSchema: z.object({
      path: z.string().describe('path relative to the working directory'),
      offset: z.number().int().min(1).optional().describe('first line, 1-based'),
      limit: z.number().int().min(1).max(5_000).optional().describe('how many lines'),
    }),
    execute: async ({ path, offset, limit }) => {
      const content = readFileSync(inside(ctx.cwd, path), 'utf8');
      if (offset === undefined && limit === undefined) return clip(content, ctx.limits.toolOutputChars);
      const lines = content.split('\n');
      const start = (offset ?? 1) - 1;
      const slice = lines.slice(start, start + (limit ?? 2_000));
      return clip(slice.map((line, i) => `${start + i + 1}\t${line}`).join('\n'), ctx.limits.toolOutputChars);
    },
  }),

  list_files: tool({
    description: 'List files in the working directory, optionally filtered by a glob.',
    inputSchema: z.object({
      glob: z.string().optional().describe('e.g. src/**/*.ts'),
    }),
    execute: async ({ glob }) => {
      const found: string[] = [];
      walk(ctx.cwd, ctx.cwd, found, 20_000);
      const filtered = found.filter((path) => matches(path, glob)).slice(0, 2_000);
      return clip(filtered.join('\n') || 'no files matched', ctx.limits.toolOutputChars);
    },
  }),

  search: tool({
    description: 'Search file contents for a regular expression.',
    inputSchema: z.object({
      pattern: z.string().min(1),
      glob: z.string().optional().describe('restrict to paths matching this glob'),
    }),
    execute: async ({ pattern, glob }) => {
      // `git grep` is used rather than ripgrep because git is already a hard
      // dependency of every runner and it respects .gitignore, which is most of
      // what makes a search usable inside a checkout.
      const args = ['grep', '-n', '-I', '--no-color', '-e', pattern];
      if (glob) args.push('--', glob);
      const out = await new Promise<string>((done) => {
        execFile('git', args, { cwd: ctx.cwd, maxBuffer: 8 * 1024 * 1024 }, (_err, stdout, stderr) => {
          done(stdout || stderr || '');
        });
      });
      return clip(out.trim() || 'no matches', ctx.limits.toolOutputChars);
    },
  }),

  git_diff: tool({
    description:
      'Show the working tree diff, optionally against a base branch. Use it to see your own accumulated change, or the change under review.',
    inputSchema: z.object({
      base: z.string().optional().describe('base ref, e.g. origin/main'),
      path: z.string().optional().describe('limit to one path'),
    }),
    execute: async ({ base, path }) => {
      // Read-only runs need this: a review has no shell, and without a diff it
      // is reviewing a repository rather than a change.
      const args = ['diff', ...(base ? [`${base}...HEAD`] : []), ...(path ? ['--', path] : [])];
      const out = await new Promise<string>((done) => {
        execFile('git', args, { cwd: ctx.cwd, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout, stderr) => {
          done(stdout || stderr || '');
        });
      });
      return clip(out.trim() || 'no differences', ctx.limits.toolOutputChars);
    },
  }),
});

/** One git invocation in the run's worktree, output clipped. Never networked. */
async function git(ctx: ToolContext, args: readonly string[]): Promise<string> {
  const out = await new Promise<string>((done) => {
    execFile('git', [...args], { cwd: ctx.cwd, maxBuffer: 16 * 1024 * 1024 }, (_err, stdout, stderr) => {
      done(stdout || stderr || '');
    });
  });
  return clip(out.trim(), ctx.limits.toolOutputChars);
}

const writeTools = (ctx: ToolContext): ToolSet => ({
  git_status: tool({
    description: 'Show which files in the working tree are modified, added or untracked.',
    inputSchema: z.object({}),
    execute: async () => (await git(ctx, ['status', '--short', '--branch'])) || 'clean',
  }),

  git_log: tool({
    description: 'Show recent commits on this branch.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    execute: async ({ limit }) => (await git(ctx, ['log', `-${limit ?? 20}`, '--oneline', '--no-decorate'])) || 'no commits',
  }),

  /**
   * Committing is local, needs no credential and does not reach the network, so
   * it belongs to the agent: a long change is easier to review with structure
   * than as one pile. Publishing it is still Companion's, after review.
   */
  git_commit: tool({
    description: 'Commit everything currently changed in the working tree. Local only; publishing happens after review.',
    inputSchema: z.object({ message: z.string().trim().min(1).max(2_000) }),
    execute: async ({ message }) => {
      await git(ctx, ['add', '-A']);
      const out = await git(ctx, ['commit', '-m', message]);
      return out || 'nothing to commit';
    },
  }),

  git_restore: tool({
    description: 'Discard your changes to a file and restore it to its committed state.',
    inputSchema: z.object({ path: z.string().min(1) }),
    execute: async ({ path }) => {
      inside(ctx.cwd, path);
      const out = await git(ctx, ['restore', '--', path]);
      return out || `restored ${path}`;
    },
  }),

  write_file: tool({
    description: 'Create or overwrite a file with the given content.',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path, content }) => {
      const target = inside(ctx.cwd, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf8');
      return `wrote ${path} (${content.length} characters)`;
    },
  }),

  edit_file: tool({
    description:
      'Replace an exact string in a file. Fails when the string is absent or appears more than once, unless replace_all is set.',
    inputSchema: z.object({
      path: z.string(),
      old_text: z.string().min(1),
      new_text: z.string(),
      replace_all: z.boolean().optional(),
    }),
    execute: async ({ path, old_text, new_text, replace_all }) => {
      const target = inside(ctx.cwd, path);
      const before = readFileSync(target, 'utf8');
      const occurrences = before.split(old_text).length - 1;
      if (occurrences === 0) throw new Error(`old_text was not found in ${path}`);
      if (occurrences > 1 && replace_all !== true) {
        throw new Error(`old_text appears ${occurrences} times in ${path}; include more context or set replace_all`);
      }
      writeFileSync(target, replace_all === true ? before.split(old_text).join(new_text) : before.replace(old_text, new_text), 'utf8');
      return `edited ${path} (${occurrences} replacement${occurrences === 1 ? '' : 's'})`;
    },
  }),

  run: tool({
    description:
      'Run a shell command in the working directory. Use it for builds, tests, and local git (status, diff, log). Pushing is refused.',
    inputSchema: z.object({
      command: z.string().min(1),
      timeout_ms: z.number().int().min(1_000).optional(),
    }),
    execute: async ({ command, timeout_ms }) => {
      const denied = DENIED_COMMANDS.find((entry) => entry.rule.test(command));
      if (denied) throw new Error(`refused: ${denied.why}`);
      const timeout = Math.min(timeout_ms ?? ctx.limits.commandTimeoutMs, ctx.limits.commandTimeoutMs);
      return await new Promise<string>((done) => {
        const child = spawn(command, { cwd: ctx.cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const collect = (chunk: Buffer): void => {
          output = (output + chunk.toString('utf8')).slice(-ctx.limits.toolOutputChars * 2);
        };
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);
        const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
        // A spawn that never starts (a shell that is not there) emits `error`
        // with nothing listening, which would take the whole runtime down.
        child.on('error', (err) => collect(Buffer.from(String(err.message))));
        child.on('close', (code) => {
          clearTimeout(timer);
          done(clip(`exit code ${code ?? 'signal'}\n${output.trim()}`, ctx.limits.toolOutputChars));
        });
      });
    },
  }),
});

/**
 * The repository's OWN gate, rather than a command the model guessed. It is
 * configured per repository and already executed this way for a run entering
 * review, so an agent that checks its work checks it against the same thing a
 * human will see.
 */
const verifyTool = (ctx: ToolContext, command: string): ToolSet => ({
  verify: tool({
    description: `Run this repository's configured verification command (${command}) and report the result.`,
    inputSchema: z.object({}),
    execute: async () => {
      return await new Promise<string>((done) => {
        const child = spawn(command, { cwd: ctx.cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        const collect = (chunk: Buffer): void => {
          output = (output + chunk.toString('utf8')).slice(-ctx.limits.toolOutputChars * 2);
        };
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);
        const timer = setTimeout(() => child.kill('SIGKILL'), ctx.limits.commandTimeoutMs);
        child.on('error', (err) => collect(Buffer.from(String(err.message))));
        child.on('close', (code) => {
          clearTimeout(timer);
          done(clip(`${code === 0 ? 'verification passed' : `verification FAILED (exit ${code})`}\n${output.trim()}`, ctx.limits.toolOutputChars));
        });
      });
    },
  }),
});

/**
 * Most of what Companion asks an agent for is a structured verdict, not prose:
 * a slop score, a triage decision, a review, a generated spec. Those are parsed
 * out of the final message today, which is why a schema is offered as a TOOL
 * instead: the provider validates the shape before the value ever reaches the
 * parser, so a malformed answer is a retryable tool error rather than a run
 * that succeeded and produced something nobody can read.
 */
const resultTool = (ctx: ToolContext, schema: unknown): ToolSet => ({
  submit_result: tool({
    description:
      'Submit the final structured answer for this task. Call it exactly once, when you are done. Its schema is the answer the caller asked for.',
    inputSchema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]),
    execute: async (value: unknown) => {
      ctx.onResult?.(value);
      return 'recorded';
    },
  }),
});

/**
 * The platform surface, for a run that operates Companion rather than a
 * checkout. The credential stays in this process: the previous shape wrote a
 * token into the run's working directory and told the model to curl with it,
 * which put a live credential in a tree that also holds untrusted code.
 *
 * Authority is not this tool's to decide. The session it carries is minted
 * read-only and the router refuses ordinary writes on it, so a confused or
 * injected model reaching for a mutation is stopped server-side.
 */
const companionApiTool = (ctx: ToolContext, api: { baseUrl: string; token: string }): ToolSet => ({
  companion_api: tool({
    description:
      "Call this Companion instance's own REST API. GET reads any permitted resource; POST is limited to preparing an action for a person to confirm, and to opening a screen in their browser.",
    inputSchema: z.object({
      method: z.enum(['GET', 'POST']),
      path: z.string().describe('a path under /api/, e.g. /api/workspaces'),
      body: z.unknown().optional(),
    }),
    execute: async ({ method, path, body }) => {
      if (!path.startsWith('/api/')) throw new Error('path must start with /api/');
      const response = await fetch(`${api.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${api.token}`,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
      });
      const text = await response.text();
      return clip(`HTTP ${response.status}\n${text}`, ctx.limits.toolOutputChars);
    },
  }),
});

export function toolsFor(access: RuntimeAccess, ctx: ToolContext): ToolSet {
  const result = ctx.resultSchema !== undefined ? resultTool(ctx, ctx.resultSchema) : {};
  // Guarded at every access, including read-only. "Read-only" is a statement
  // about this checkout; an MCP server reaches something else entirely, and
  // whether one of its tools writes is not ours to know.
  const mcp = guarded({ ...ctx.mcpTools }, ctx);
  if (access === 'trusted-assistant') {
    return { ...(ctx.companionApi ? companionApiTool(ctx, ctx.companionApi) : {}), ...mcp, ...result };
  }
  if (access === 'read-only') return { ...readOnlyTools(ctx), ...mcp, ...result };
  return {
    ...readOnlyTools(ctx),
    // Only what mutates is guarded: reading is not a decision anyone wants to
    // be asked about twenty times, and a person asked that often stops reading.
    ...guarded({ ...writeTools(ctx), ...(ctx.verifyCommand ? verifyTool(ctx, ctx.verifyCommand) : {}) }, ctx),
    ...mcp,
    ...result,
  };
}

/** Whether a path is a readable file, used by the state loader. */
export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
