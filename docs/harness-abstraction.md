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

Six field-level details, all measured, each of which is the difference between a
harness that works and one that quietly lies:

- **`is_error` is absent on success**, and `true` on failure. It is not `false`.
  A harness that tests for the key's presence marks every successful tool call
  as failed.
- **`system/init` repeats per turn**, not once per session. Two prompts down one
  `--input-format stream-json` process produce two `init` frames under one
  `session_id`, so session info is a per-turn refresh rather than a handshake.
- **`rate_limit_event` fires during a perfectly healthy turn** with
  `rate_limit_info.status: "allowed"`. Only a non-allowed status is an error.
  Treating the frame itself as one puts a spurious warning in every transcript.
- **The stream is genuinely out of lockstep.** `assistant` frames arrive one per
  content block, and a result for call 1 can land while call 2's arguments are
  still streaming. Position cannot pair a result with its call; `tool_use_id`
  can, and does.
- **`stop_reason` arrives late**, on `message_delta`, after the per-block
  `assistant` frames it describes. Nothing in Companion reads `stopReason`
  today, so this costs nothing yet and will need a deferred flush when it does.
- **The prompt is never echoed.** moxxy emits `user_prompt`; Claude Code does
  not. That event is Companion's to synthesize from what it sent.

**Codex** is now measured too, from two real turns once its CLI was working. The
shape is analogous but named thread/turn/item instead of session/turn/event:

| Companion event | Codex |
|---|---|
| session | `thread.started`, carrying `thread_id` |
| turn boundaries | `turn.started`, `turn.completed`, `turn.failed` |
| `assistant_message` | `item.completed` with `item.type: agent_message` |
| `tool_call_requested` | `item.started` with `item.type: command_execution` |
| `tool_result` | `item.completed` for that same item |
| usage | `turn.completed.usage` |

Items carry a stable `id` and `started`/`completed` pair by it, so the same rule
that works for Claude Code works here.

Four differences from Claude Code, and they are exactly the class that makes an
adapter written for one quietly wrong on the other:

- **Failure is inverted and always present.** A command result carries
  `exit_code` and `status`, `0`/`completed` on success and `1`/`failed` with
  stderr in `aggregated_output` on failure. Claude Code omits `is_error`
  entirely on success. An adapter that tests for a key's presence is right for
  one and wrong for the other.
- **No cost, only tokens.** `turn.completed.usage` gives `input_tokens`,
  `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens` and
  `reasoning_output_tokens`, with no dollar figure. Claude Code reports
  `total_cost_usd` directly. So the spend ceiling has two paths: take the number
  from Claude Code, price the tokens from `modules/operate/src/contract/model-pricing.ts`
  for Codex.
- **A tool call is a shell command**, not a named tool with structured input, so
  there is nothing to render as a tool name and argument list.
- **No chunk-level streaming was observed.** Items arrive completed, so there
  may be no equivalent of `assistant_chunk` and therefore no live typing. Not
  proven absent, but not seen in either capture.

Codex also opens with an `agent_message` before its first command, a preamble
rather than an answer.

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
having one. Both candidates report, but not the same thing: Claude Code gives a
dollar figure, Codex gives tokens only. So the capability cannot be a boolean
that means "has usage"; the ceiling either takes a price or computes one.

## The plan

Each phase is shippable on its own and leaves the tree working.

### 1. Prove the mapping before refactoring anything (done, it holds)

Write a throwaway adapter that reads Claude Code's stream-json and emits our
event shape, run the same prompt through both it and moxxy, and compare the
transcripts. No production code changes. If the vocabulary does not survive
this, the rest of the plan is wrong and it costs a day to find out.

**It survived.** One prompt ("read alpha.txt, beta.txt and gamma.txt, then say
which existed"; gamma does not exist, so the turn contains two tool successes
and one tool failure) was run through Claude Code and through moxxy, and both
transcripts were folded by the real `fold.ts`. They fold to the same block
stream: the same user prompt, the same three tool blocks, the failure on the
same call, the same final answer. Claude Code additionally produced `reasoning`
blocks, which moxxy's provider did not emit on that run but which the vocabulary
and the fold already handle. Every event type the adapter emitted was one
`fold.ts` already knew, so nothing landed on the `default: break` arm.

The pairing claim was checked against the thing it could be confused with. An
adapter that pairs the nth result with the nth call agrees with the real one on
the untouched capture, so the capture alone proves nothing. Permuting the
`tool_result` frames leaves the id-reading adapter's output identical and moves
the order-reading one's failure onto the wrong file; swapping two `tool_use_id`
values moves the id-reading adapter's failure and leaves the order-reading one
unmoved. Deleting `is_error` from the failing result makes that call succeed
even though its text still reads "File does not exist", and flipping
`rate_limit_info.status` from `allowed` to `rejected` is what turns a silent
frame into a warning. In every case the transcript follows the field, not the
prose.

What this does not prove: Codex, which is still unmeasured; and the per-call
approval round trip, which neither candidate offers and which no adapter can
invent.

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

## Choosing at setup, by detecting rather than asking

First-run setup already asks which modules to start with. It should also settle
which harnesses this machine will use, and it should do it the way the Providers
page now does it: **detect first, and only ask about what is really there.**

A harness is installed software, so the answer is on disk. `moxxy`, `claude` and
`codex` are either on PATH or they are not, and the check costs nothing.

Three states, not two, and this is not hypothetical. On the machine these
measurements were taken, `codex` is installed **and unusable**: its model cache
is corrupt and its account rejects the models it is configured for. Offering it
as a choice there would produce an instance that looks configured and fails on
its first run.

- **Ready**: on PATH and its own auth check passes. Offer it, ticked.
- **Installed but not ready**: on PATH, sign-in or self-check fails. Offer it
  unticked, saying what is wrong and the one command that fixes it.
- **Absent**: not offered and **not mentioned**. Advertising software someone
  has not installed turns a setup step into a catalogue, and the list is exactly
  as long as the machine's real options.

The question is a **multi-select**: harnesses are not exclusive, and an instance
that has both moxxy and Claude Code should be able to place work on either.
Per-runner selection means the local runner gets the set picked here, and a
remote machine answers the same question from its own disk when it is attached.

The one case that still needs words is an empty list, because a question with no
options is not a question. If nothing is detected, say so once and name the
choices, since at that point the operator genuinely has none rather than being
sold one they skipped.

One consequence for existing copy: the CLI says today that moxxy is "optional at
startup, but required before running AI agents". That stops being true in
general and becomes true only of an instance that chose moxxy.

## Decisions still open

**Where the choice lives.** Per instance is simplest. Per runner mirrors
providers, which are already per machine, and matches reality: a harness is
installed software. Per task is the most flexible and probably premature.
Per runner is the decision.

**The runner agent.** Remote machines run `companion-runner`, whose protocol
carries moxxy-shaped calls. A second harness means the agent has to know which
one to spawn, which is a protocol change and therefore a version bump with the
usual "this agent predates it" path.

**Whether moxxy stays the default.** It should. It is the only implementation
with the full capability set, and everything above degrades gracefully rather
than assuming parity.
