# Real harness captures

Not hand-written. Each file is the untouched output of one real run, kept
because the adapters' claims are about fields that only appear in a genuine
stream: a tool result landing while the next call's arguments are still
streaming, a `rate_limit_event` in the middle of a healthy turn, `is_error`
present only on the failure, and `stop_reason` arriving after the frames it
describes.

A fixture on its own proves nothing, which is why `claude-adapter.test.mjs` and
`codex-adapter.test.mjs` mutate these before asserting: the untouched capture
cannot tell a correct adapter from one that pairs results by position, and the
permutations can.

The two harnesses are also each other's control. Both captures run the same
errand, two files that exist and one that does not, because the field that
reports the failure is the one place an adapter written for either is silently
wrong on the other: Claude Code omits `is_error` on success, Codex reports
`exit_code` on both outcomes.

| File | How it was produced |
|---|---|
| `claude-stream.jsonl` | `claude --print --output-format stream-json --include-partial-messages --verbose --model haiku --allowedTools Read` on the prompt "Read alpha.txt, then read beta.txt, then read gamma.txt...", run in a directory holding `alpha.txt` (apple) and `beta.txt` (banana) but no `gamma.txt`, so the turn contains two tool successes and one tool failure. |
| `claude-stream-two-turns.jsonl` | The same CLI with `--input-format stream-json` and two user frames on stdin ("Reply with exactly: ONE", then TWO). Shows `system/init` repeating per turn under one `session_id`. |
| `claude-session-file.jsonl` | The session file Claude Code wrote to disk for the first run: what a reaped run's transcript is read back from. |
| `codex-stream.jsonl` | `codex exec --json --sandbox read-only` (CLI 0.146.0) on the prompt "Run exactly these three commands... `cat alpha.txt`, `cat beta.txt`, `cat gamma.txt`... Run all three even if one fails", in a directory holding the first two. Two commands exit 0 / `completed`, the third exits 1 / `failed`. |
| `codex-rollout.jsonl` | The rollout file Codex wrote to disk for that same run: what a reaped run's transcript is read back from, and a different shape from the stream. |

Two edits to the Claude Code session file and the Codex rollout, both of the
same kind and neither touching anything an adapter reads.

The payload of the session file's three `attachment` frames was replaced with a
marker. They described the environment the capture was taken in (the tool,
agent and skill listings of the shell that ran `claude`), which says nothing
about Claude Code's format. The frames themselves stay, because `attachment` is
one of the types the adapter must ignore and the test that pins that reads the
type, never the payload.

The rollout's `session_meta`, `world_state`, `turn_context` and developer
`message` payloads were replaced the same way and for the same reason: they are
that machine's instructions, filesystem and shell rather than Codex's format,
and `codex-adapter.test.mjs` asserts those record types are ignored by removing
them entirely and requiring the transcript not to move. Its working directory
was renamed to `/capture`, which is the one machine-specific string an adapter
genuinely reads, since it appears inside the commands that were run.
