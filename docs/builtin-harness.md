# The built-in harness: running agents with no external CLI

Every harness Companion runs today is somebody else's binary: `moxxy`, `claude`,
`codex`. Each one is installed on a machine by a person, signs itself in
interactively, and keeps its provider credentials in that person's home
directory. That is a good fit for a maintainer's laptop and it is the single
thing standing between Companion and being deployed by a platform team.

This is a plan for a fourth harness that is not a binary: an agent loop
Companion owns, built on the Vercel AI SDK, running as a subprocess of the
bundle that is already running, taking its model credentials from Companion's
own secret store. Nothing to install, nothing to sign in to, no PATH.

It is written against the seams that already exist ([`harness-abstraction.md`](harness-abstraction.md)
phases 1 to 6 are done) and says which parts are cheap because of them and which
are genuinely new surface.

## What it unlocks, stated plainly

**A container that boots into a working instance.** Today a fresh
`docker run` produces an instance that can serve the UI and sync GitHub and
cannot run a single agent turn until somebody execs into it and authenticates a
CLI. `Dockerfile` bakes in `npm install -g @moxxy/cli` and the comment above
that line is about fighting layer caching for it. With this harness the runtime
dependency list for agent work is: an API key in the secret store. That is the
whole "cloud" story, and it is upstream of everything else on this page.

**Runners that autoscale.** `companion-runner` is already the data plane
(`ENTERPRISE.md` §2 makes the single-node control plane a decision, and points
at runners for scale). A runner today still needs a human to install and log in
a runtime on it. A runner whose harness ships inside its own bundle is a plain
container image, which is the difference between "add a machine" and "set
replicas".

**Per-call approvals, which no other harness can offer.**
`harness-abstraction.md` names this as the one thing that does not map:
Claude Code and Codex settle permission as a start-time policy and offer no
headless round trip, so `capabilities.approvals` is `policy` for both and
attended chat runs under a fixed fence. We own this loop, so we can stop before
a tool call and raise an `AskRequest`. It is the only harness besides moxxy that
can be `interactive`.

**A credential that never touches disk.** AI Help currently writes a scoped
session token into the run's working directory and tells the model to `curl`
with it (`modules/automations/src/api/assistant.ts`, `writeCredentials` plus a
900-word briefing that is mostly an API cookbook). With typed tools the token
lives in the parent process, the model gets a tool list instead of a curl
tutorial, and no credential file is ever written into a tree that also holds
checked-out third-party code.

## What it is not

It will not write better code than Claude Code. A harness is a context strategy,
a tool set, a retry policy and a thousand small decisions about truncation, and
the teams shipping those CLIs work on nothing else. Pretending otherwise would
be the same defect the transcript work just fixed: an instance that looks
configured and is worse than it claims.

So the position is: **the built-in harness is the floor, not the ceiling.** It
is what every instance has, what unattended structured work runs on, and what a
platform team can deploy. An operator who wants the best coding agent installs
one and picks it per runner, exactly as they do now.

## Where to point it first, and why it is not coding

`runOneShot` (`modules/operate/src/api/orchestrator.ts:1095`) is prompt in,
final message out. It is what issue triage, PR review, pipeline steps, slop
scoring, spec and doc generation, proposal analysis, the planner, refinement,
automations and the playground all call: nine modules, constantly, and by call
site it is the most-used entry into an agent in this codebase. Much of it needs
no repository at all (`cwd` is optional and deliberately omitted for runs that
must not tokenize a checkout).

That is the first workload, before any coding run:

- the fidelity bar is a parseable verdict, not a good diff;
- a bad turn produces a visible refusal through the existing tolerant-parse path
  rather than a plausible wrong change;
- `modules/playground` already stores saved deterministic evaluations
  (`production-evaluations.ts`), so "is this harness good enough for this
  prompt" is a measurement this repo can already take, on the same prompt set,
  against moxxy.

Coding runs come after that measurement, not before it.

## The shape

### One subprocess per run, and not in-process

Modules run in-process with the database handle and full filesystem access, and
`ENTERPRISE.md` §5 says so out loud. An agent loop with a shell tool must not
live there: a prompt-injected turn would be inside the control plane's address
space, holding its handles.

So the harness spawns `process.execPath` against its own bundle with a hidden
`agent-exec` subcommand, one child per run, cwd set to the run's worktree. This
is the pattern `ClaudeCodeHarness` already implements, minus the part where the
binary might be missing: NDJSON on stdout, one JSON frame per line, a line per
turn written to stdin, the process is the session. It buys crash isolation, a
memory ceiling, a kill that actually ends the work, and a supervisor model the
runner already knows how to operate.

The cost is honest: an extra Node process per live run, bounded by the same
`maxLive` ceiling that bounds gateways today.

### The wire is our own event type

Claude Code and Codex each needed an adapter because they emit their own
vocabulary. This one emits `HarnessEvent` (`packages/types/src/harness.ts`)
natively: `user_prompt`, `assistant_chunk`, `assistant_message`,
`tool_call_requested`, `tool_result`, `provider_response`, `error`. No adapter,
no mapping table, no measurement phase, and the ids are ours so pairing is not a
question.

Two events that only this harness can emit honestly: `tool_call_approved` /
`tool_call_denied` (we know), and `compaction` (we do it).

### Where the code lives

A module **and** a package, and it has to be both.
`packages/runtime` (`@moxxy/companion-runtime`) holds the loop, the tools and
the AI SDK providers, because two bundles must run it and `companion-runner`
loads no modules. `modules/runtime` holds the provider records, their secrets,
the routes, the RBAC and the page, because those are module things. It is not in
the slim build. [`cloud-runtime.md`](cloud-runtime.md) is that whole story:
the split, the profiles, and how the child is located in each delivery vehicle.

One consequence for sequencing: phase 7 of `harness-abstraction.md` (an open
harness registry a module can register into) stops being an optional later
cleanup and becomes the **prerequisite**, because `HARNESSES` in
`modules/operate/src/api/harnesses.ts` is a constant array that names its
implementations by import. Land it first, as its own provably no-op change, with
the three existing harnesses moved onto it.

New dependencies: `ai`, plus the AI SDK provider packages named in
[`model-providers.md`](model-providers.md). That is a real cost against the
dependency discipline this repo keeps, and it lands in an optional module rather
than in the build every npx user gets, which is most of why the module split is
worth its own package boundary.

### Detection cannot say "absent"

`harness-detect.ts` asks a machine what is on its PATH. This harness is the
process asking, so it is always installed, and its three states collapse onto
one question: is a model credential configured and does a probe call succeed.
`ready` when yes, `installed` with `fix: "add a provider key under Settings"`
when no, never `absent`. Which also means a fresh instance always has at least
one harness to offer at first-run setup, and the empty-list case that
`harness-abstraction.md` had to write words for stops existing.

## Tools

One catalog, gated by the run's `AgentRunAccess`, which is already the hard
per-run boundary (`packages/types/src/runner-agent.ts:53`).

| Tool | read-only | workspace-write | trusted-assistant |
|---|---|---|---|
| `read_file` | yes | yes | no |
| `list_files` (glob) | yes | yes | no |
| `search` (via `git grep`) | yes | yes | no |
| `write_file` | no | yes | no |
| `edit_file` (exact match, ambiguity is an error) | no | yes | no |
| `run` (shell in cwd, capped, timed) | no | yes | no |
| Companion loopback tools | no | narrow | yes |
| Configured MCP servers | per policy | per policy | per policy |

`search` shells out to `git grep` rather than `rg`: git is already a hard
dependency of every runner, ripgrep is not, and `git grep` respects
`.gitignore`, which is most of what makes a search tool usable in a checkout.

Three deliberate absences.

**No network git, and no GitHub token.** The user-facing ask was "git operations
by token" and the honest answer is no. Every network git operation on every
runner already resolves its write credential through one function on the daemon,
which is where `agentGitWrite`, `protectedBranches` and the audit entry live
(`ENTERPRISE.md` §4). Handing the agent a token routes around all three. Local
git (`status`, `diff`, `log`, `branch`) is available through `run`; commit and
push stay where they are, executed by the orchestrator through `Checkouts` after
review. `run` additionally refuses a `git push` prefix, as a second layer only,
exactly as `DENIED_TOOLS` does for Claude Code and with the same caveat that it
does not survive a shell wrapper. The fence is the credential-less worktree.

**No repository instruction files by default.** `AGENTS.md`, `CLAUDE.md`, hooks
and MCP config found in a checkout are untrusted input, not configuration. Claude
Code needs `--safe-mode` for this; we get it by not implementing it. Opt-in per
repository if somebody wants it, off by default.

**No `trusted-assistant` filesystem access.** AI Help operates the platform; it
has no business reading a checkout. Today it is told not to in prose. Here it is
a tool list.

## Credentials and the model catalog

This is the largest genuinely new surface, and it inverts an existing property:
today "model credentials belong to the machine, and Companion stores no copy"
(`apps/companion-runner/README.md`). A built-in harness declares
`capabilities.models: 'providers'` and the operator supplies keys to Companion.

The contract for that (records, model catalog, pricing, extension, config as
code, and where the credential is stored) is [`model-providers.md`](model-providers.md).
Two things from it matter to the harness itself. The runtime is handed a fully
resolved spec at spawn and **carries no provider names and no defaults**, so a
missing spec is a failed turn rather than a silent fallback to whatever
environment variable happened to be set. And no capability axis changes:
`capabilities.models: 'providers'` already means "the operator supplies
credentials per provider", and only their storage location moves from a machine
to Companion.

**Who holds the key at runtime** is a real decision, not a detail:

- *Env to the child* is what every harness effectively does today (Claude Code's
  own credentials sit readable on the same disk the agent has a shell on).
  Simple, and no worse than the status quo.
- *A loopback proxy* keeps the key in the parent: the child constructs its
  provider with a custom `fetch` that goes back over a one-time loopback socket,
  and the parent attaches the credential. A prompt-injected turn can then burn
  tokens for the length of its run and cannot exfiltrate a key that outlives it.

Recommendation: ship env first, write the proxy down as a named phase, and do it
when it can be paired with process-level sandboxing rather than on its own.

## Approvals

Because we own the loop, a tool call can be suspended before execution, raised
as an `AskRequest` over the same pipe, and resolved through the existing
`respondAsk` path that moxxy already uses end to end. `PermissionMode` already
has `allow`, `allow_session`, `allow_always` and `deny`, and the UI is already
capability-aware, so an interactive harness lights up affordances that are built
and currently dark for two of three harnesses.

Unattended runs auto-allow within their access fence, which is the existing rule
and needs no new mechanism.

## Usage and the ceiling

The AI SDK reports token usage per step, so `capabilities.usage` is `tokens` and
the spend ceiling prices it from `modules/operate/src/contract/model-pricing.ts`
exactly as Codex does. That table carries Anthropic list prices, so a run on any
other provider contributes zero to the ceiling and says so on the budget card.
Under BYOK that becomes the common case rather than the exception, which is why
the price is snapshotted onto the run row at creation from the model record and
the built-in table is the fallback: see the pricing sections of
[`model-providers.md`](model-providers.md) and [`cloud-runtime.md`](cloud-runtime.md).
A ceiling that quietly stops describing most of the spend is worse than no
ceiling, and that is the failure mode here.

`maxRunOutputTokens` already exists as a per-run ceiling. Add a per-turn step
ceiling and a tool-output cap, because an agent loop with neither is an
unbounded bill.

## Session, history, resume

We write the transcript, so `loadHistory` reads our own file under the run's
directory, with the retention the storage cleanup pass already enforces.

One non-obvious requirement: **the display transcript is not the continuation
record.** `HarnessEvent` is shaped for the UI and the fold, and resuming a
session needs the model-facing message array, including provider-specific blocks
that must be preserved verbatim across a tool loop. Persist both: the event
NDJSON for the UI, and the SDK's own `response.messages` for continuation.
Deriving the second from the first is possible and lossy, and the loss shows up
as a provider error on the second turn of a resumed run.

## Reaching back into Companion

Two separate things, and conflating them would be a mistake.

**A generic MCP client** so an instance can attach its own MCP servers per
runner or per repository, with the tool list gated by the run's access. This is
plumbing and is the smaller half.

**Companion's own surface as tools.** The stdio MCP server exists
(`apps/companion-cli/src/mcp.ts`), is filtered by the connected user's role and
enabled modules, and deliberately has **no execute tool**: a model prepares, a
browser session confirms. That boundary is load-bearing for AI Help and should
not be widened just because the client is now in-process.

The ask that motivated this ("the runner should be able to move statuses") is
narrower than a write token, and should stay narrow: a run gets tools scoped to
**its own work item** (its board card, its review, its own run row) and nothing
else, minted per run from the same `mintSession` path AI Help uses, audited like
every other mutation. "Set the status of the card this run was launched for" is
a different authority from "call any mutation as this user", and only the first
is needed.

## The remote runner

`companion-runner` speaks `RUNNER_AGENT_PROTOCOL = 6` and `AgentSpawnRequest`
carries `cwd`, `sessionId` and `access` but no harness id, so a remote machine
runs whatever it runs. `harness-abstraction.md` lists this as an open decision
and it becomes the blocking one here, because a runner that cannot be told
"built-in" cannot be the autoscaling data plane this is for.

Protocol 7 adds the run's harness id and model to the spawn request. The old
"this agent predates it" path applies: an agent answering the old shape keeps
running its own default rather than being refused.

**And one thing that must not be waved through.** The runner endpoint is plain
HTTP unless the operator writes `https://` (`apps/companion-runner/README.md`).
Sending a provider API key over that per run would be a downgrade from today,
where the key never leaves the machine it was configured on. So: the runner
holds its own provider credentials by default, exactly as
`COMPANION_RUNNER_GITHUB_TOKEN` overrides the daemon's git credential, and
daemon-supplied keys are refused unless the endpoint is https. Fail loudly on
that, do not degrade.

## Hosting shape

Nothing here makes Companion multi-tenant, and the plan should not imply it.
`ENTERPRISE.md` §2 decided single-node, and the reasoning (clones, worktrees,
scratch space and the isolated runtime home all live on local disk) is untouched
by this work. What changes is that an instance stops needing a human on the box.

```
control plane            data plane
one daemon per instance  N runner containers
  DB, worktree policy,     each: companion-runner
  RBAC, audit, budgets       + built-in harness
  places work  ───────►      + git, own clones
                             + one agent subprocess per run
```

The supervisor already exists: `companion-runner` bounds live runs
(`COMPANION_RUNNER_MAX_RUNS`), spawns and stops them, and enforces daemon-owned
storage retention. What it gains is a child process per run to bound: memory
(`--max-old-space-size` plus an rlimit), wall clock (there is a turn timeout
already), and output. A per-run container or a dedicated uid is a later phase
and belongs with the keyless-child work, not before it.

Two costs to state before somebody sets replicas to 8. A cold runner clones
every repository it is given work for, so a fresh replica is slow on its first
run of each repo and wants a volume. And placement is provider-aware already, so
a fleet where only some machines have credentials configured will silently
concentrate work; make the built-in harness's readiness visible per runner.

## Phases

Each is shippable on its own and leaves the tree working.

**0. Open the harness registry (done).** Phase 7 of `harness-abstraction.md`,
done first and alone. `HARNESSES` became `allHarnesses()` over a compiled-in
list plus a registry a module writes into, `LocalRunnerBackend` dispatches on
the registry before its two named branches, and detection takes contributed
answers alongside the three PATH probes. No behaviour change for the three
harnesses that were already there.

**1. The child and its stream (done).** `packages/runtime`: the subprocess
entry, the tool set, the provider factory table, NDJSON `HarnessEvent` on
stdout, one turn per stdin line, the continuation record persisted separately
from the display transcript. What remains of this phase is the measurement: run
the same prompt set through it and through moxxy on the playground's saved
evaluations before anything depends on the answer.

**2. The parent (done).** `modules/runtime` registers the harness on enable and
takes it back out on disable, `LocalRunnerBackend` spawns it, detection reports
`ready` or `installed` and never `absent`, and the child is located through the
package in a checkout and through `dist/agent.js` in the bundle. Local runner
only.

**3. Providers (done, minus the price snapshot).** The `model_providers` table,
the credential in the kernel's secret store, the routes, the page, the probe,
config-as-code adoption at enable, and `models: 'providers'`. The run-row price
snapshot is the piece still outstanding, so a BYOK model outside the built-in
table still prices as unknown.

**4. One-shots in production.** Make it selectable per runner and per task for
`runOneShot` work, and thread `resultSchema` from the callers that parse JSON out
of a final message today. The runtime side of that is built (`submit_result`);
the orchestrator does not send a schema yet. Measure against moxxy on the saved
evaluations before changing any default.

**5. Write tools and coding runs.** `write_file`, `edit_file`, `run`, the push
refusal, output caps, context compaction. Coding runs opt-in per runner.

**6. Interactive approvals.** `approvals: 'interactive'`, ask over the pipe,
per-tool policy. The dark UI lights up.

**7. Loopback and MCP.** Typed Companion tools for AI Help (retiring the curl
briefing and the on-disk credential), narrow scoped write tools for a run's own
work item, generic MCP client.

**8. Remote.** Protocol 7 carries the harness id; runner-held provider
credentials; https-or-refuse for daemon-supplied keys.

**9. Hardening.** Keyless child over the loopback proxy, child resource
ceilings, an image with no external runtime, optional per-run isolation.

## Risks, and what would make me stop

- **Quality.** Phase 1 exists to find this out for the cheapest workload before
  anything depends on it. If the built-in harness cannot produce a parseable
  slop verdict as reliably as moxxy, stop at phase 1 and keep this as a
  deployment convenience for nothing.
- **Maintenance.** Context management, retries, provider quirks and tool-output
  truncation are the actual work of a harness, and they never finish. Scoping it
  to the floor rather than the ceiling is what keeps that bounded.
- **Dependency surface.** `ai` and the provider packages move quickly, and they
  land in a bundle that is also the Docker image.
- **The inverted credential model.** Companion holding provider keys is a new
  class of secret for this product. Routing it through the existing secret seam
  from day one is what stops that being a regression.

## Decisions still open

**The harness id.** `companion` reads correctly in the Runners and Providers UI
and is what this document assumes. `builtin` collides confusingly with
`capabilities.models: 'builtin'`, which means the opposite thing here.

**Whether it becomes the default for one-shots**, and on what evidence. The
default should move only on a measured comparison, and only for the workload
that was measured.

**Whether the module is OSS or entitled.** The runtime is what makes Companion
work without an external CLI, so gating it makes the free product worse where
people evaluate it. The argument and the recommended split are in
[`cloud-runtime.md`](cloud-runtime.md); it is a commercial decision, not a
technical one.
