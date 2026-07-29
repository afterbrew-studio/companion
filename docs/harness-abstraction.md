# Running agents through something other than moxxy

Companion drives moxxy today, and moxxy is assumed in three different roles at
once: the thing that runs a turn, the thing that holds provider credentials, and
the thing that says which models exist. This is a plan for separating the first
role from the other two, so an instance can run its agents through a harness the
operator already has installed.

Written after reading both candidate CLIs and capturing their real event streams,
not their documentation. What follows says which parts are measured and which are
still assumptions.

## Why it is cheaper than it looks

Two things that would normally sink this are already true.

**The event vocabulary is an open union.** `MoxxyEventType` ends in
`(string & {})` with the note that unknown types must be tolerated, and
`fold.ts` ends its switch with `default: break`. The repo also holds the line
that nothing exhaustively switches on it. So a harness that emits a different
set of events does not break the transcript by construction.

**The seam is small.** `RunnerBackend` has 34 methods, but it answers "which
machine", not "which agent runtime". The harness coupling lives in
`GatewayClient`, and its whole surface is:

```
connect / close / isOpen
runTurn(args) -> turnId        abortTurn(turnId)
sessionInfo()                  loadHistory()
respondAsk(requestId, response)
setModel / setProvider / setMode / setAutoApprove / runCommand
```

The first five are the contract. The last five are moxxy's own and belong behind
a capability check rather than in the interface everyone must implement.

## What the candidates actually emit

**Claude Code**, measured from one real turn with
`--print --output-format stream-json --include-partial-messages`:

| Companion event | Claude Code |
|---|---|
| `assistant_chunk` | `stream_event / content_block_delta` |
| `assistant_message` | `assistant` |
| `tool_call_requested` | `tool_use` block, carrying `id` |
| `tool_result` | `tool_result` block, carrying `tool_use_id` and `is_error` |
| `error` | `result.is_error`, `api_error_status`, plus a distinct `rate_limit_event` |

Tool calls and their results pair by id, which was the open question and is the
thing a transcript cannot fake. `system/init` reports the model, the tool list,
the permission mode, MCP servers and skills, which is most of what `sessionInfo`
is for. `result` carries `usage` broken down by cache plus `total_cost_usd`, so
the spend ceiling keeps working. `--input-format stream-json` accepts further
turns, so a session is not one prompt.

**Codex** was measured only as far as its vocabulary, because the CLI on the
machine used for this could not complete a turn: its model cache is corrupt
(`missing field supports_reasoning_summaries`) and a ChatGPT account rejected the
models tried. What it does show is `thread.started`, `turn.started`,
`turn.failed`, `error`, and `item.completed` carrying `item { id, type }`. The
shape is analogous, named thread/turn/item instead of session/turn/event. Treat
Codex fidelity as unproven until someone repeats this on a working install.

**A distinction worth stating once**, because conflating it will waste a day:
`openai-codex` in moxxy is a **provider**, credentials for an API. The `codex`
CLI is a **harness**. An instance can have the first working and the second
broken, which is exactly the state of the machine this was measured on.

## The three things that do not come for free

These are the design, not the detail.

**The model catalog moves.** Placement, model pins, provider policy and the
Providers page all read moxxy's `sessionInfo`. A built-in harness brings its own
sign-in and its own model list and exposes no notion of "providers". So which
models exist becomes a per-harness answer, and everything that reads the catalog
has to accept that.

**Approvals are a policy, not a conversation.** `respondAsk` lets a person
approve one tool call mid-turn. Both candidates express permission as a policy
set up front: `--permission-mode` and `--allowedTools` for Claude Code,
`--sandbox` for Codex. Neither offers a headless round trip to a browser. So
unattended work maps completely, and attended chat with per-call approval does
not. MCP is the plausible bridge and is not in this plan.

**Usage reporting decides whether the ceiling is real.** A harness that does not
report tokens turns the spend ceiling off silently, which is worse than not
having one. Claude Code reports cost directly. Codex is unverified.

## The plan

Each phase is shippable on its own and leaves the tree working.

### 1. Prove the mapping before refactoring anything

Write a throwaway adapter that reads Claude Code's stream-json and emits our
event shape, run the same prompt through both it and moxxy, and compare the
transcripts. No production code changes. If the vocabulary does not survive
this, the rest of the plan is wrong and it costs a day to find out.

### 2. Split the contract

`packages/types/src/moxxy.ts` is 250 lines and already describes itself as a
hand-declared subset written defensively. Split it:

- the event union, turn arguments, ask shapes and history become
  agent-agnostic types under a neutral name;
- the JSON-RPC frames and the `moxxy.v1` subprotocol constants stay, as moxxy's
  wire format and nothing else.

Keep aliases for one release so the 21 importing files move mechanically, under
typecheck rather than by hand.

### 3. Define the interface, with moxxy as its only implementation

Extract `Harness` from `GatewayClient`'s first five methods, plus a capability
declaration. At minimum: whether approvals are `interactive` or `policy`,
whether usage is reported, and where models come from. No behaviour changes in
this phase; it is the load-bearing refactor and should be provably a no-op.

### 4. Make the UI capability-aware

Before a second harness exists, not after. Companion asks what the harness can
do and stops offering what it cannot: the approval affordance, provider policy,
slash commands, modes. Doing this after would mean shipping a harness whose UI
lies, which is the same defect we just fixed in the transcript.

### 5. The Claude Code harness, unattended first

Board workers, fix runs and pipeline steps, which is where the fidelity is
complete and the value is highest. Attended chat comes later or runs under a
fixed policy, stated in the UI.

### 6. Harness as a module

The registry, the SDK and the published ABI already exist, and `board` already
registers a run task through them. A third party shipping opencode, hermes or pi
should be a module registering a harness, with no core change. This is what
makes the contract genuinely open rather than a two-way switch.

## Decisions still open

**Where the choice lives.** Per instance is simplest. Per runner mirrors
providers, which are already per machine, and matches reality: a harness is
installed software. Per task is the most flexible and probably premature.
Per runner is the recommendation.

**The runner agent.** Remote machines run `companion-runner`, whose protocol
carries moxxy-shaped calls. A second harness means the agent has to know which
one to spawn, which is a protocol change and therefore a version bump with the
usual "this agent predates it" path.

**Whether moxxy stays the default.** It should. It is the only implementation
with the full capability set, and everything above degrades gracefully rather
than assuming parity.
