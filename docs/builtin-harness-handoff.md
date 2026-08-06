# Built-in runtime: where the work stands

Written to be the only thing a fresh session has to read. The design is in
[`builtin-harness.md`](builtin-harness.md), [`model-providers.md`](model-providers.md)
and [`cloud-runtime.md`](cloud-runtime.md); this is the state of the build.

Branch: `worktree-plan+companion-runner-harness`.

## Built and verified

Gates on every commit: `pnpm build`, `pnpm typecheck`, `pnpm acl check`
(53 permissions / 16 modules), and 24 tests (`pnpm -r test` in
`packages/runtime`, `apps/companion-runner` and `modules/runtime`).

| Area | State |
|---|---|
| Harness registry opened (`registerHarness`) | done, three existing harnesses moved onto it |
| `packages/runtime` (subprocess loop, tools, providers, compaction, approvals) | done |
| `modules/runtime` (records, secrets, routes, page, harness registration) | done |
| BYOK: 4 provider kinds, config-as-code, probe, discovery, per-workspace scope | done |
| Protocol 7: harness id, spec, limits, verify command, result schema, attendance | done |
| Remote runner runs the built-in runtime | done, integration-tested against a live agent process |
| A fix run's mechanics on a runner (worktree → change → diff → commit → verify → push) | done, integration-tested |
| Structured one-shots (`resultSchemaOf`) at 13 call sites in 6 modules | done |
| Interactive approvals, bounded wait, transcript entries | done |
| Price snapshot on the run row, spend grouped by it | done |
| `cloud` profile, `INSTALL_MOXXY=false`, `docker build --target runner` | done |
| `companion provider` CLI, first-run key prompt | done |
| MCP client: stdio + Streamable HTTP, records, policy, UI, config-as-code | done |

Verified once against the real OpenAI API (a coding turn and a structured
verdict validated by module-slop's own production parser). That run found two
defects, both fixed and guarded by tests: a schema needs the system prompt to
*require* the result tool, and a low step ceiling costs the answer rather than
just the exploration.

## Not built

**Companion's own surface as narrow tools.** AI Help still reaches the platform
through a single `companion_api` tool rather than the per-work-item tools the
plan describes ("set the status of the card this run was launched for" is a
different authority from "call any mutation as this user"). The generic MCP
client is done and is not this; see `builtin-harness.md` §"Reaching back into
Companion", which keeps the two apart deliberately.

**A run driven by a live daemon.** Everything is proven by driving the runner's
own HTTP+WS surface the way `RemoteRunnerBackend` does, which covers the
mechanics but not the daemon's placement, budget gate and review handoff. That
needs `pnpm dev` plus a registered runner, and the operator runs dev servers.

## Two things a fresh session should know

**The tool guard must replace `execute` in place.** `tool()` returns a branded
value the SDK checks before it will execute anything; a spread produces a
look-alike that is silently never called, which presents as "the model did not
use the tool".

**A denied tool call returns its refusal, it does not throw.** Thrown, the
reason is stripped before the model sees it. Whether the model gets a further
step after a refusal is the provider's call and the runtime claims nothing
about it.

**A tool set that is shared between turns collects one guard per turn.** Because
the guard replaces `execute` in place, `McpHub.toolSet()` rebuilds rather than
caches. A cached set asks a person to approve the same call twice on turn two.

**Registering a signal handler in the child replaces default termination.** The
child now handles SIGTERM so it can stop the MCP servers it started, which means
it must also release stdin: a flowing stdin holds the process alive until the
parent's follow-up SIGKILL, turning every clean stop into a hard one.
