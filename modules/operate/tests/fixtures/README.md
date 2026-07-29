# Real Claude Code captures

Not hand-written. Each file is the untouched output of one real run, kept
because the adapter's claims are about fields that only appear in a genuine
stream: a tool result landing while the next call's arguments are still
streaming, a `rate_limit_event` in the middle of a healthy turn, `is_error`
present only on the failure, and `stop_reason` arriving after the frames it
describes.

A fixture on its own proves nothing, which is why `claude-adapter.test.mjs`
mutates these before asserting: the untouched capture cannot tell a correct
adapter from one that pairs results by position, and the permutations can.

| File | How it was produced |
|---|---|
| `claude-stream.jsonl` | `claude --print --output-format stream-json --include-partial-messages --verbose --model haiku --allowedTools Read` on the prompt "Read alpha.txt, then read beta.txt, then read gamma.txt...", run in a directory holding `alpha.txt` (apple) and `beta.txt` (banana) but no `gamma.txt`, so the turn contains two tool successes and one tool failure. |
| `claude-stream-two-turns.jsonl` | The same CLI with `--input-format stream-json` and two user frames on stdin ("Reply with exactly: ONE", then TWO). Shows `system/init` repeating per turn under one `session_id`. |
| `claude-session-file.jsonl` | The session file Claude Code wrote to disk for the first run: what a reaped run's transcript is read back from. |

One edit, and only one: the payload of the session file's three `attachment`
frames was replaced with a marker. They described the environment the capture
was taken in (the tool, agent and skill listings of the shell that ran
`claude`), which says nothing about Claude Code's format. The frames themselves
stay, because `attachment` is one of the types the adapter must ignore and the
test that pins that reads the type, never the payload. Nothing else in any file
was touched, and nothing the adapter reads was.
