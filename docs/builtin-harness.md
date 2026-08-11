# The built-in harness: running agents with no external CLI

Three of the harnesses Companion runs are somebody else's binary: `moxxy`,
`claude`, `codex`. Each is installed on a machine by a person, signs itself in
interactively, and keeps its provider credentials in that person's home
directory. That is a good fit for a maintainer's laptop and a poor fit for a
platform team.

The fourth harness is not a binary. It is an agent loop Companion owns, built
on the Vercel AI SDK, running as a subprocess of the bundle that is already
running, taking its model credentials from Companion's own secret store.
Nothing to install, nothing to sign in to, no PATH.

It ships as two pieces: `packages/runtime` (`@moxxy/companion-runtime`) holds
the loop, the tools and the AI SDK providers; `modules/runtime` holds the
provider records, their secrets, the routes, the RBAC and the Model providers
page.
The module is compiled into the `full` and `cloud` profiles (and into the
published npx CLI, which is a full build) and lands as **Available**
(`autoInstall: false`), so turning it on is explicit:

```sh
companion module install runtime
companion provider add "Anthropic" --kind anthropic --key sk-… --model claude-sonnet-5
```

[`model-providers.md`](model-providers.md) covers the provider records;
[`cloud-runtime.md`](cloud-runtime.md) covers the deployment story.

## What it provides

**A container that boots into a working instance.** The runtime dependency
list for agent work is an API key in the secret store. No CLI install, no
interactive sign-in, no second volume for a runtime home.

**Runners that scale like containers.** `companion-runner` bundles the same
runtime package, so a remote runner is a plain container with no CLI to
install and nobody to log in.

**Per-call approvals, which no other harness besides moxxy offers.** Claude
Code and Codex settle permission as a start-time policy. Companion owns this
loop, so a mutating tool call can stop, raise an `AskRequest` over the same
pipe its events go out on, and wait for the answer.

**Structured answers validated at the provider.** When a caller asks for a
schema, the run gets a `submit_result` tool carrying that JSON Schema, so a
verdict is validated before it ever reaches a parser.

## What it is not

It does not write better code than a dedicated coding CLI. A harness is a
context strategy, a tool set, a retry policy and a thousand small decisions
about truncation, and the teams shipping those CLIs work on nothing else. The
built-in harness is **the floor, not the ceiling**: it is what every instance
can have, what unattended structured work runs on, and what a platform team
can deploy. An operator who wants a specific coding agent installs one and
picks it per runner, exactly as before.

## The shape

**One subprocess per run, not in-process.** Modules run in-process with the
database handle and full filesystem access. An agent loop with a shell tool
must not live there, so the harness spawns one child per run
(`packages/runtime/src/child`), cwd set to the run's worktree, speaking
newline-delimited JSON: `HarnessEvent` frames out on stdout, one turn per
stdin line. That buys crash isolation, a memory ceiling, and a kill that
actually ends the work.

**The wire is Companion's own event type.** Claude Code and Codex each needed
an adapter because they emit their own vocabulary. This harness emits
`HarnessEvent` (`packages/types/src/harness.ts`) natively: `user_prompt`,
`assistant_chunk`, `assistant_message`, `tool_call_requested`, `tool_result`,
`provider_response`, `error`, and three events only it can emit honestly:
`tool_call_approved`, `tool_call_denied` and `compaction`.

**Detection never says "absent".** The harness is the process asking, so
detection reports `ready` when a model provider is configured, and `installed`
with a fix (`companion provider add …`) when not. A fresh instance therefore
always has at least one harness to offer.

**Registered like any other harness.** The harness registry is open: the
module registers the harness (id `companion`, label "Companion") on enable and
removes it on disable. Its capabilities are `approvals: 'interactive'`,
`usage: 'tokens'`, `models: 'providers'`.

## Tools

One catalog, gated by the run's access (`AgentRunAccess`,
`packages/types/src/runner-agent.ts`), assembled in
`packages/runtime/src/child/tools.ts`:

| Tool | read-only | workspace-write | trusted-assistant |
|---|---|---|---|
| `read_file` | yes | yes | no |
| `list_files` (glob) | yes | yes | no |
| `search` (via `git grep`) | yes | yes | no |
| `git_diff` | yes | yes | no |
| `write_file` | no | yes | no |
| `edit_file` (exact match, ambiguity is an error) | no | yes | no |
| `run` (shell in cwd, capped, timed) | no | yes | no |
| `git_status`, `git_log`, `git_commit`, `git_restore` | no | yes | no |
| `verify` (the repository's own command) | no | yes | no |
| `submit_result` (when the caller asked for a schema) | yes | yes | yes |
| `companion_api` (scoped, read-only session) | no | no | yes |
| Configured MCP servers | per policy | per policy | per policy |

`search` shells out to `git grep` rather than `rg`: git is already a hard
dependency of every runner, ripgrep is not, and `git grep` respects
`.gitignore`. `git_diff` sits in the read-only column deliberately: a review
run has no shell, and without a diff it is reviewing a repository rather than
a change. `verify` runs the command the repository itself declares, resolved
through the same resolver the pre-review check uses.

### Which git operations the agent gets, and which it does not

Committing is local, needs no credential and makes a long change reviewable,
so it is a tool. The refusals each have their own reason, and the shell names
it rather than leaving the model to interpret a failure:

| Operation | Agent | Why |
|---|---|---|
| `git_commit`, `git_status`, `git_log`, `git_diff`, `git_restore` | yes | local, no credential, no network |
| `push` | no | Companion pushes after review, at the one credential seam that carries the policy and the audit entry |
| `fetch` / `pull` | no | Companion prepared this worktree at the base it wants; moving the base mid-run moves the diff under the review |
| `checkout` / `switch` | no | the run row records one branch; switching makes the diff, the review and the eventual push describe something else |
| `worktree` | no | worktrees are allocated and swept by Companion; one made inside is invisible to it |
| `remote` | no | the remote decides where a later push lands |

Two more deliberate absences. **Repository instruction files are not
configuration**: `AGENTS.md`, `CLAUDE.md`, hooks and MCP config found in a
checkout are untrusted input and are not loaded. And **`trusted-assistant` has
no filesystem access**: AI Help operates the platform, and it has no business
reading a checkout. That is enforced as a tool list, not as prose.

## Credentials and the model catalog

The runtime is handed a fully resolved model spec at spawn, in the `start`
frame over stdin (not argv, which is world-readable in `ps`), and **carries no
provider names and no defaults**: a missing spec is a failed turn, never a
silent fallback to an environment variable that happened to be set. The
records, catalog, probing and pricing behind that spec are
[`model-providers.md`](model-providers.md).

The child process holds the key for the duration of the run. Moving it behind
a loopback proxy so the key never enters the process running untrusted
repository content is planned hardening, not shipped.

## Approvals

Because Companion owns the loop, a mutating tool call can be suspended before
execution, raised as an `AskRequest`, and resolved through the same
`respondAsk` path moxxy uses end to end, with `allow`, `allow_session`,
`allow_always` and `deny`. Three rules shape it
(`packages/runtime/src/child/approvals.ts`):

- **Only what mutates is guarded.** A person asked to approve twenty reads
  stops reading, and reading changes nothing.
- **Only an attended run asks.** Unattended work auto-allows within its access
  fence, which is the existing rule for every harness; an approval nobody can
  answer would sit until the turn timed out.
- **A refusal is returned as the tool's result, not thrown.** A thrown refusal
  reaches the model as "the tool failed" with the reason stripped; returned,
  the text is the model's to read and to explain.

MCP tools are behind the approval guard at **every** access, read-only
included: "read-only" describes this checkout, and whether an external
server's tool writes is not Companion's to know.

## Usage and ceilings

The AI SDK reports token usage per step, and the price a run executed at is
snapshotted onto its row at creation (`runs_price_snapshot`,
`modules/operate/src/api/migrations.ts`), so a completed run prices itself and
editing a provider record never reprices money already spent. A model with no
declared price contributes zero to the spend ceiling and the budget card says
the total is partial.

Per-run limits are explicit (`RuntimeLimits`, `packages/runtime/src/spec.ts`):
a step ceiling per turn, a turn timeout, a per-command timeout, a tool-output
cap, and a child heap ceiling. Context compaction runs at exchange boundaries
against the model's declared context window; an undeclared window turns
compaction off rather than trimming against a guess.

## Session, history, resume

The display transcript is not the continuation record. The event NDJSON is
shaped for the UI; resuming a session needs the model-facing message array,
including provider-specific blocks preserved verbatim across a tool loop. The
runtime persists both, and a restarted run resumes from the continuation
record.

## MCP

An instance can attach its own MCP servers (a command run directly, or a
Streamable HTTP endpoint) as records on the runtime module: the run accesses
each serves, an optional tool allowlist, a workspace scope, and one secret per
server in the kernel's secret store, substituted wherever the operator wrote
`${secret}`. The daemon resolves the list for a run and hands the runtime the
result, so nothing in the agent process decides who may reach what. See
[`configuration.md`](configuration.md#mcp-servers-for-the-built-in-runtime).

- Tools are namespaced `mcp__<server>__<tool>`, so an MCP tool is never
  mistaken for a built-in one in a transcript or an approval card.
- A server that will not connect costs its own tools and nothing else; the
  failure lands on the transcript as a non-fatal `error`.
- A server's tool descriptions and results are untrusted third-party text, and
  the system prompt says so whenever any are attached.

Companion's own surface is different and narrower: `companion_api` carries a
read-only session minted for the run, and the router refuses ordinary writes
on it server-side. There is deliberately no generic execute authority; a model
prepares, a person confirms, exactly as with the [stdio MCP
server](ai-help-and-mcp.md).

## The remote runner

The runner protocol (`RUNNER_AGENT_PROTOCOL = 7`) carries the run's harness id
and resolved model spec, and `companion-runner` bundles the same runtime
package, so a remote machine runs the built-in harness with no checkout and no
installed CLI. An agent too old for the protocol reports a mismatch and never
receives placement.

One rule is not softened: **a model spec crosses to a runner only over
https.** The runner endpoint is plain http unless the operator made it
otherwise, so an http runner carries its own provider credentials (the
`COMPANION_RUNNER_PROVIDER_*` variables) and a runner with neither refuses the
spawn and names both fixes, rather than accepting work it cannot finish. See
[`runners.md`](runners.md).

A cold runner clones every repository it is given work for, so a fresh
replica is slow on its first run of each repo and wants a volume.
