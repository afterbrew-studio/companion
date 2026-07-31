# Spec: executable pipeline steps, and secrets for them

**Status: implemented 2026-07-31**, on one branch rather than the PR sequence
§11 describes. Written against the tree at that point; file and line references
were true then.

Built: the process-group kill fix, step outputs + interpolation, the `executable`
and `npm-bootstrap` step kinds with `pipelines:execute` and the instance switch,
per-invocation secret injection with redaction, `mergeStateStatus` + branch
protection + the `pr-state-gate` and `merge` steps, a hardened `checks-gate`,
pipeline export/import, and CI webhooks for live check freshness.

Built since: owner-bound secrets (no instance-wide credential remains), the
`pipelines:execute` / `pipelines:author-execute` split, admission control so
executable steps queue instead of spawning unbounded shells, a queue page,
bulk actions on selections, CI rerun with a PR action registry and gate-emitted
remedies, streamed step output with a boundary-safe scrubber, and job logs fed
into both CI analysis and CI repair.

Not built, and deliberately deferred: resume from a failed step (§8.2), the
per-repo publish lock (§8.3), the runner capability probe (§8.4), and
remote-runner secrets (§4.4, refused at runtime rather than silently dropped).
Review threads remain the largest untouched daily gap.

Verification so far is `pnpm typecheck`, `pnpm build`, `pnpm acl check` and
targeted harnesses for the pure logic (process-group kill, redaction, the
boundary-safe stream scrubber, detection parsing, secret ownership, the remedy
vocabulary). Nothing has yet published a real package, merged a real PR, or been
rendered in a browser.

The goal is narrow and concrete: make `~/.claude/scripts/octane-merge-pr.sh` a
Companion pipeline, so landing a PR that adds an npm package stops being a
terminal session. Everything here follows from that one target.

---

## 1. Read the script first

The script is 370 lines and it is the specification. It has already paid for the
lessons this port must not lose, so the mapping below starts from it rather than
from what a pipeline could plausibly do.

| Script phase | What it actually is | Port as |
|---|---|---|
| Preflight (`command -v`, `gh auth status`, clean tree) | environment assumptions | mostly **delete**, see §9 |
| 1. PR state (merged? draft? mergeable? poll UNKNOWN) | GitHub API | new `pr-state-gate` step |
| 2. Staleness (behind count, protection, file overlap) | GitHub API + set math | new `staleness-gate` step |
| 3. New packages (`pnpm release:preflight` + parse) | **shell** | `npm-bootstrap` step, parsing in TS |
| 4. Checks (buckets, required contexts by name) | GitHub API | harden existing `checks-gate` |
| 5. Bootstrap (pack check, publish, trust, verify) | **shell + a secret** | `npm-bootstrap` step |
| 6. Merge (head-SHA re-check, squash, `--admin`) | GitHub API | new `merge` step |
| 7. Return to base | local git hygiene | **delete**, Companion owns its checkouts |

**Only two of seven phases actually need a shell.** That is the load-bearing
finding. If the port becomes one `executable` step that runs the whole script,
every benefit is lost: no per-step status, no gate that blocks structurally, no
streamed output, no resume from the failed step, and the same terminal round trip
wearing a different hat. The gates are the product; the shell is the escape hatch.

So this spec proposes both, and is explicit about which is which.

### Lessons in the script that must survive the port

These are not incidental. Each one is a bug the script already caught.

- **`assert_bootstrap_count`** parses the package list *and* cross-checks it
  against the count `release:preflight` prints, dying if they disagree. It exists
  because a wording change once turned "N need bootstrap" into a silent zero.
  A regex capture alone reintroduces exactly that failure.
- **`gh pr checks` exit code is not a gate.** It exits non-zero merely because a
  check is pending. The script insists on parseable JSON and refuses to fall back
  to an empty array, because "0 of 0 failed" reads as green.
- **All-skipped is not green.** `passed > 0` is required separately from
  `failing == 0`.
- **Counting checks is insufficient.** A required context missing from the list
  entirely sails past a count. Each required context is verified by name.
- **`mergeable` is `UNKNOWN` until GitHub's background job finishes**, and a
  merged PR reports `UNKNOWN` forever. Poll, and check merged-ness first.
- **The head can move mid-run.** Before merging, the script re-reads the head SHA
  and refuses if it differs from the one every gate was evaluated against.
- **`pnpm pack` + `grep workspace:`** proves the workspace protocol was rewritten
  *before* anything is published. This check needs no credential, so it runs
  before the token is ever resolved.
- **Verify from the registry, not from exit codes.** Publish succeeding while
  `npm trust` silently failed is the worst state to merge in: preflight goes quiet
  because the package now exists, yet CI still cannot publish it.
- **Record what `--admin` skipped while the branch is still behind.** After the
  merge, `origin/main` contains the PR and reading it then describes the wrong
  commits.

---

## 2. Phase 0: steps must be able to talk to each other

Nothing else in this spec is possible without this, and it is currently missing.

`PipelineStepResult` (`modules/code/src/contract/pipelines.ts:143`) carries
`name`, `kind`, `status`, `summary`, `detail`, and timestamps. All prose.
`StepContext` (`modules/code/src/api/pipelines.ts:160`) carries `repo`, `userId`,
`type`, `pr`, `issue`. A handler cannot see what any earlier step produced.

Two additions:

```ts
export interface PipelineStepResult {
  // ...existing
  /** Named values this step exported for later steps. Never secrets. */
  readonly outputs?: Readonly<Record<string, string>>;
}

interface StepContext {
  // ...existing
  /** Results of steps already finished in this run, in order. */
  readonly completed: ReadonlyArray<PipelineStepResult>;
}
```

Plus interpolation in step config, following the syntax the `comment` step already
uses for `{{pr.number}}`: `{{steps.<name>.outputs.<key>}}`.

Outputs are strings and are stored in the run record, so they are visible in
history. That is deliberate and it is why the rule is absolute: **an output must
never carry a secret.** Secrets travel only through §4.

---

## 3. The `executable` step

### 3.1 What it is

A step that runs a shell command in a working directory Companion prepared, on the
runner the run is placed on, streams its output, and gates on its exit code.

```ts
export interface ExecutableStep extends BaseStep {
  readonly kind: 'executable';
  readonly config: {
    /** Run through `sh -c`. Shell syntax is the point; see §3.3. */
    readonly command: string;
    readonly workdir: 'pr-worktree' | 'clone' | 'scratch';
    readonly timeoutMs: number;
    /** Secret config keys → env var names. Values resolved at invocation. */
    readonly secrets: ReadonlyArray<{ readonly key: string; readonly env: string }>;
    /** Extract named outputs from stdout for later steps. */
    readonly capture?: ReadonlyArray<{ readonly name: string; readonly pattern: string }>;
    /** Exit codes that still count as passed. Empty means only 0. */
    readonly allowExitCodes?: ReadonlyArray<number>;
  };
}
```

`PIPELINE_TYPE_STEPS` gains `executable` for all three pipeline types. A
`platform` pipeline with executable steps is how repo maintenance (regenerate
inventories, run a codemod, refresh a lockfile) stops needing a terminal.

### 3.2 It does not need a new execution substrate

`RunnerBackend.verify(cwd, command, timeoutMs)`
(`modules/operate/src/api/backend.ts:85`) already runs a command in a worktree on
the correct machine, local or remote, with HTTP proxying for remote runners and a
`null` return for runners too old to have the endpoint (recorded as "unavailable",
not as failure, because "we could not check" and "it does not build" are different
answers).

`executable` is `verify` generalized along three axes:

1. a command from the step config rather than one string per repo,
2. an env overlay resolved per invocation (§4),
3. streamed output instead of a tail-clipped return value.

The current caps have to move with it. `MAX_OUTPUT` is 8 KB
(`modules/operate/src/exec/verify.ts:4`) and the default timeout is 10 minutes.
A publish plus a full inventory regeneration exceeds both. Streaming makes the
output cap a retention question rather than a truncation question: stream
everything live, persist a bounded tail.

### 3.3 Why "unsafe" is the honest label, and what actually contains it

This step executes arbitrary code as the daemon user. Calling it anything softer
would be a lie, and the `[unsafe]` framing in the UI should be kept verbatim.

The comment at `modules/operate/src/exec/verify.ts:20` explains why the *existing*
shell path is defensible: the command comes from repository configuration written
by someone who already manages that repository, and it never comes from a request
body. An `executable` step keeps the second half of that (the command lives in a
stored pipeline definition, snapshotted into the run) and weakens the first half,
so the containment has to be rebuilt explicitly:

**A dedicated permission.** Today `maintainer` holds `pipelines:manage`
(`modules/code/src/api/acl.ts:30`). Riding executable steps on that permission
silently promotes every maintainer from "edits automation config" to "runs code as
the daemon user". A new `pipelines:execute` permission, granted to `admin` only by
default, keeps that promotion a deliberate act.

**An instance kill switch.** Module config flag, default off. An instance that
never enables it cannot be reached through this path at all, which matters because
most instances will never need it.

**Audit, always.** Every invocation records actor, pipeline, step, the command
text, the secret *names* injected, the exit code, and the duration. This is the
privilege-escalation path in the product; it is the one thing that must be
reconstructable afterwards.

**No inline secrets.** Secrets reach the process only through `config.secrets`.
A value typed into `command` would be snapshotted into the run record and shown in
history. The UI should reject a `command` matching known credential shapes rather
than trusting the author to remember.

### 3.4 What it deliberately cannot do

No tty, so nothing interactive. `read -r reply </dev/tty` and `npm login` have no
answer here; approval moves to §6. No network access controls beyond what the host
already has. No privilege separation from the daemon: an executable step is as
trusted as companiond itself, which is precisely why §3.3 exists.

---

## 4. The npm token: full lifecycle

Requirements taken directly from the ask: transmitted safely, removed after the
run, live for one invocation only, and never present in the audit trail.

### 4.1 Which token

An npm **granular access token**, scoped to the `@octanejs` scope only, with
publish permission, with an expiry set (30 or 90 days) and a rotation reminder.
Not a classic token: classic tokens are all-or-nothing and require an OTP per
write, which cannot be serviced without a tty.

The narrow scope is doing real work here. §4.6 explains why the token is
unavoidably exposed to third-party code at the moment of publish, and a token that
can only publish under one scope bounds what that exposure is worth.

### 4.2 Storage

The `SecretStore` seam already exists and is the right shape
(`packages/core/src/server/capabilities.ts:132`). A `kind: 'secret'` config field
on the owning module. The kernel already guarantees the value never reaches a
client: `ModuleConfigState` exposes only *whether* a secret is set, never the
value. Default backend is SQLite in Companion home; an organisation that keeps
secrets in Vault swaps the provider without touching this design.

Nothing new is needed here. That is the point of having built the seam.

### 4.3 Transmission, local runner

Resolve from `SecretStore` at the moment of invocation. Build the child's env.
Spawn. That is the whole path, and every step of it is a deliberate refusal of a
more convenient option:

- **Not `process.env`.** Putting the token there hands it to every agent run on
  every repository, including runs on branches from first-time contributors.
- **Not the persisted run spec.** `runSpec(runId)` is read back on boot recovery,
  so a value stored there survives restarts on disk in plaintext. Specs carry
  secret *names*; the backend resolves *values* at spawn.
- **Not `npm config set`.** That writes `~/.npmrc` on the runner and outlives the
  run.

### 4.3.1 Verified, not assumed

Measured 2026-07-31 on npm 11.16.0, pnpm 10.30.0, node 24.18.0, macOS. Method: a
local mock registry that logs the `Authorization` header, so every mechanism was
proven with a fake value and no real credential. Re-run before trusting these on
another machine; the scratch harness is a 12-line node script.

`npm config get '//registry.npmjs.org/:_authToken'` **refuses to print protected
options**, so config introspection cannot be used to verify this. Observing the
outgoing header is the only honest test.

| Command | `NPM_CONFIG_//host/:_authToken` in env | userconfig with `${VAR}` |
|---|---|---|
| `npm whoami` | sent `Bearer <value>` | sent `Bearer <value>` |
| `pnpm publish` | sent `Bearer <value>` | sent `Bearer <value>` |
| `npm trust list` (GET `/-/package/<pkg>/trust`) | sent `Bearer <value>` | same path |
| `npm trust github` (POST `/-/package/<pkg>/trust`) | same path | sent `Bearer <value>` |

Both mechanisms work, on both the read and the write path, for all three tools.
The exotic env var name is legal through `execve` even though no shell can assign
it, and npm parses it.

Two further findings, both useful:

- **`npm trust github --dry-run` makes no network request at all.** The preview
  the merge procedure calls for is entirely local, costs nothing, and needs no
  credential. Run it unconditionally.
- **No token leakage into npm's own logs**, including at `--loglevel=silly`.
  `NPM_CONFIG_LOGS_DIR` redirects them to a run-scoped directory anyway, which is
  worth doing so a step's logs are collected with the step.

### 4.3.2 The mechanism that removes the removal problem

npm interpolates `${VAR}` from the environment when it reads an npmrc. So the file

```
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
```

**contains no credential.** It is a template. The secret exists only in the child
process's environment, and the npmrc is inert text that could be committed to a
public repository without consequence.

This is the answer to "guarantee it is always removed", and it is stronger than any
cleanup routine: **there is nothing on disk to delete.** A `finally` block can be
skipped by SIGKILL, a power cut, or a bug in the error path. An absent file cannot.

Preference order, both verified:

1. `NPM_CONFIG_//registry.npmjs.org/:_authToken=<token>` in the child env only.
   No file at all. This is the default.
2. `NPM_CONFIG_USERCONFIG=<path>` pointing at the template above, with `NPM_TOKEN`
   in the child env. For any future tool that does not parse the exotic env var
   name. The file still holds no secret, so it needs no protected cleanup and no
   boot sweep.

### 4.3.3 What must never be used: the inline shell prefix

`sh -c 'NPM_TOKEN=xxx pnpm publish && npm trust ...'` is the obvious-looking option
and it is the one that leaks. Measured:

```
$ sh -c 'NPM_TOKEN=npm_FAKEINLINE1234567890 true && sleep 4' &
$ ps -ww -eo pid,command | grep npm_FAKE
79902 sh -c NPM_TOKEN=npm_FAKEINLINE1234567890 true && sleep 4
```

The token is in the shell's `argv`, readable by `ps` for any process running as the
same user, for as long as the shell lives. The same command with the env passed
programmatically to `spawn` shows nothing.

A single simple command happens to escape this, because `sh -c 'VAR=x cmd'` execs
`cmd` directly and the shell's argv disappears. Every compound command (`&&`, `;`,
a pipeline) keeps the shell alive and exposed, and compound commands are exactly
what an executable step is for. So the rule is unconditional: **the secret goes in
the `env` object handed to `spawn`, and the command text never mentions it.**

### 4.4 Transmission, remote runner

`RemoteBackend.spawn` posts to the runner agent over HTTP
(`modules/operate/src/api/remote-backend.ts:148`). Sending a token that way means
a credential crossing a network boundary into a second codebase.

There is precedent and it is documented: `provisionProvider`
(`modules/operate/src/api/backend.ts:32`) hands live provider keys to a runner
under an explicit discipline (never stored, never logged, never returned, including
through an error message). The same discipline would apply, plus verification that
the runner channel is authenticated and encrypted, plus proof the agent does not
log request bodies.

**Recommendation: secret-carrying steps are local-runner only in v1.** The
restriction is cheap because the actual use case is landing PRs from the machine
that already holds the checkout, and lifting it later is additive. Executable steps
*without* secrets can run anywhere from day one.

### 4.5 Removal and redaction

After §4.3.2 there is no file holding a credential, so removal reduces to a single
question: **does the process always die?** The environment of a dead process is
gone by the kernel's guarantee, with no cleanup code that could be skipped.

That guarantee currently has a hole, and it has to be closed before any secret is
injected.

`runVerify` (`modules/operate/src/exec/verify.ts:53`) kills on timeout with:

```ts
// The shell is the child; the actual build is its grandchild, so killing
// the group is what stops the work rather than orphaning it.
child.kill('SIGKILL');
```

The comment states the correct intent and the code does not implement it. `spawn`
is called without `detached: true`, so no new process group exists, and
`child.kill` signals the shell alone. The grandchild (`npm`, `pnpm`) is orphaned
and keeps running, **with the token still in its environment**, until it exits on
its own.

**Measured 2026-07-31, and it is worse than an orphan leak.** The pre-fix code was
reproduced exactly and driven to a timeout with a compound command
(`sleep 31338 && true`, which keeps the shell alive so the sleep is a real
grandchild). The orphaned grandchild inherits stdout and stderr, so it holds those
pipes open, and `child.on('close')` fires only once the process has exited *and*
its stdio has closed. The observed result: **`runVerify`'s promise never settles.**
The harness was killed at 60 seconds having produced no outcome at all.

So the current behaviour on a timeout with a surviving grandchild is not "a stale
process is left behind", it is "the caller hangs forever". A verify step in that
state never returns a result to the pipeline.

The fix is two lines: `detached: true` on the spawn, and
`process.kill(-child.pid, 'SIGKILL')` to signal the whole group. Verified after
the fix: the same command times out at 1509 ms, resolves with
`timedOut: true, exitCode: null`, and leaves zero surviving processes.

It is worth fixing on its own merits, and it is a precondition for §4, because
"the env dies with the process" is only true if the process reliably dies.

Beyond that, the remaining discipline is about never creating a second copy:

- Never assign to `process.env`. Build a fresh object per invocation.
- The env object is never logged, never serialized into a run record, never
  included in an error.
- The token is never written to step outputs (§2 forbids it), step `detail`, or
  the pipeline definition (§3.3 forbids inline secrets).
- Honest limitation: a JS string cannot be zeroed, so the value lives in the heap
  until GC, and a core dump of companiond could contain it. This is true of every
  secret the daemon already handles, including the ones in `SecretStore`. Disable
  core dumps on the daemon; do not pretend it is solved.

Redaction covers what leaks by accident:

- **Extend the existing scrubber.** `redactSecrets`
  (`modules/operate/src/exec/checkouts.ts:44`) already strips GitHub token shapes
  and `//user@` from git output. Add npm token patterns and apply it to executable
  step output, step summaries, and error messages.
- **Scrub across chunk boundaries.** Applying a regex per streamed chunk misses a
  token split across two chunks, which is the common case for a long value. The
  scrubber needs a carry buffer of at least the longest known credential length,
  held back from emission until the next chunk arrives or the stream ends. This is
  a real bug class, not a theoretical one; the naive version looks correct in
  testing precisely because short test tokens rarely straddle a boundary.
- **Scrub before persistence and before broadcast**, not on render. A value that
  reached SQLite is leaked regardless of what the UI does with it.

### 4.6 The exposure that scoping cannot remove

`pnpm publish` runs the published package's own `prepublishOnly` and `prepack`.
At the moment of publish the token is available to code from the pull request,
however tightly the injection is scoped. This is inherent to publishing someone
else's package and no amount of env hygiene changes it.

For this repository it is closeable. Bindings ship raw `src` with
`files: ["src","README.md","LICENSE"]` and have no build, so there is nothing for
a prepack to legitimately do. `octane` itself has a `prepack`, but `octane` is not
what gets bootstrapped. So: **`--ignore-scripts` on the bootstrap publish**, with
the step failing loudly rather than silently dropping a script if a package that
genuinely needs one ever appears.

What per-invocation scoping *does* buy, and it is worth the work: the difference
between a credential live for one `pnpm publish` you triggered, and a credential
live for a twelve-minute agent session holding an unrestricted shell. The agent
harness spawns with `--permission-mode bypassPermissions`
(`modules/operate/src/exec/claude-code.ts:163`), so any env var on that process is
readable by the agent and by everything it runs. Those are different exposure
windows by orders of magnitude, and that gap is the entire argument for keeping
publish out of agent runs.

### 4.7 Audit: the act yes, the value never

**Settled 2026-07-31: executable steps are audited.**

The token value never appears anywhere: audit, logs, run record, stream, error
message. The *invocation* is audited as completely as possible: who armed the run,
which pipeline, which step, the command text, the secret names injected, the exit
code, the timestamp. An executable step is the privilege-escalation path in this
design, and an unaudited escalation path is what makes an incident
unreconstructable. Auditing the act while never touching the credential gives both
properties.

---

## 5. `npm-bootstrap` is its own step, not an executable step

It would fit in an `executable` step. It should not be one.

The publish is irreversible, and the surrounding logic is where the script earned
its scars. `assert_bootstrap_count` is a cross-check between a parsed list and a
declared count, with a hard refusal on disagreement. Expressing that as an awk
pattern in a config text field reintroduces the silent-zero bug the assertion was
written to prevent. In a typed handler it is a few lines, it lives next to the
thing it protects, and it cannot be edited away by someone tuning a regex.

The step:

1. Runs `pnpm release:preflight` through the §3 substrate. **No token yet.**
2. Parses the `Require bootstrap` section *and* the declared count. Disagreement
   is a hard failure, never a guess.
3. Cross-checks each name against `git show origin/<base>:packages/<dir>/package.json`
   so an unrelated pre-existing gap is not attributed to this PR.
4. Per package, still with no token: `pnpm pack`, then refuse if the tarball
   contains `workspace:`.
5. `npm view <name> version`. Already published means skip, which is what makes
   the whole step re-runnable after a partial failure.
6. **Token resolved here**, for the publish and the trust registration only:
   `pnpm --filter <name> publish --access public --no-git-checks --ignore-scripts`,
   then `npm trust github <name> --file publish.yml --repo <repo> --allow-publish`.
7. Verifies from the registry: `npm view` returns a version, and
   `npm trust list <name> --json` shows the relationship. Exit codes are not proof.
8. Re-runs preflight and requires `Require bootstrap: 0`.

Outputs: the package names and their published versions, for the merge step's
disclosure and for the run history.

`--dry-run` from the script maps to a step config flag that stops after (5).

---

## 6. The GitHub gates the pipeline needs

The script is 60% GitHub API reasoning, and Companion currently cannot express
most of it. These are not optional extras; without them the pipeline cannot
replace the script.

**`mergeStateStatus` on `PrRecord`.** Today the record has only
`mergeable: boolean | null` (`modules/code/src/contract/index.ts:266`), which
cannot distinguish `CLEAN` from `BEHIND` from `BLOCKED` from `DIRTY`. Every
staleness decision in the script reads it.

**Branch protection.** Companion never reads
`repos/<owner>/<repo>/branches/<base>/protection`. Three fields are needed:
`required_status_checks.strict` (does `BEHIND` actually block), `enforce_admins`
(does a bypass exist at all), and `required_status_checks.contexts` (which checks
must pass by name).

**`pr-state-gate` step.** Merged-first (a merged PR reports `mergeable: UNKNOWN`
forever, so checking mergeability first produces a misleading failure), then draft,
then a bounded poll while `mergeable` is `UNKNOWN`.

**`staleness-gate` step.** Commits behind base, and the risk classification the
script computes: intersect the files the missing commits touch with the files the
PR touches. Empty intersection is low risk, non-empty is high. Config decides
whether high risk halts or warns. `--admin` becomes a config flag on the merge
step, allowed only when `enforce_admins` is false, and it must record the skipped
commits *before* the merge, while the branch is still behind.

**Hardened `checks-gate`.** The existing step counts. It needs: `passed > 0`
required separately from `failing == 0`, a refusal when the check list is
unparseable rather than a fallback to empty, and per-name verification of every
required context from branch protection.

**`merge` step.** Squash, delete branch, optional `--admin`. And the head-SHA
pin: the SHA is captured when the run starts, every gate is evaluated against it,
and the merge refuses if the head moved. Arming a run at T0 does not authorize
merging a different commit at T+10.

---

## 7. Where the confirmation goes

The script confirms three times (publish, trust, merge) with `--yes` to skip.
The pipeline should not ask three times, and the ask for "authoritative, not
asking" is right.

Arming the run is the approval. One decision, before anything irreversible, then
the sequence runs to completion without further prompts. Two constraints keep that
honest:

- The head-SHA pin (§6). Approval is for a specific commit, not for a PR.
- No `autoRunOnPrOpen` for a pipeline containing `npm-bootstrap` or `merge`.
  Automations fire pipelines on `pull_request.opened` and `ready_for_review`
  (`modules/automations/src/api/automations.ts:152`), which is correct for review
  and slop checking and wrong for publishing to a public registry.

---

## 8. What we would still be missing

Beyond everything above, still absent after this spec is built:

1. **Streamed step output in the UI.** Pipelines produce `summary` and `detail`
   at the end. A five-minute publish with no visible progress is worse than the
   terminal it replaced. This is required for §3, not a follow-up.
2. **Resume from the failed step.** The script is all-or-nothing. A pipeline
   should re-run from the failure, which `npm-bootstrap` is already designed for
   (step 5 skips what exists). `PipelineRunRecord` has no notion of resume today.
3. **A concurrency lock per repository.** Two people landing PRs at once, or the
   same pipeline fired twice, must not both publish. Irreversible steps need a
   lock, not optimism.
4. **Runner capability probe.** `npm trust` needs npm 11.15 or newer. The probe
   reports no tool versions, so today that is discovered halfway through a
   bootstrap. Add npm, pnpm, node and git versions to the probe and gate the step
   on them.
5. **A standalone "is main release-blocked" check.** The script's already-merged
   branch runs preflight and warns when the base still has unbootstrapped
   packages. That is a property of the repository, not of any PR, and belongs in a
   scheduled automation with a notification.
6. **Review threads and CI rerun.** Unchanged from the earlier analysis and still
   the highest-frequency daily gap. This spec covers landing; it does not touch
   reviewing.

---

## 9. What we deliberately do not port

The script's preflight exists because it runs in a personal checkout. Companion's
answers are structural, and reimplementing the checks would be cargo cult:

- **Dirty working tree refusal.** Companion owns its clones and worktrees; the
  user's own checkout is never touched.
- **`restore_branch` trap.** Same reason. There is no branch to strand anyone on.
- **`gh auth status`.** The multi-account registry with purposes and permission
  ranks is a better answer than a binary auth check.
- **`command -v git gh pnpm npm jq`.** Replaced by the runner capability probe
  (§8.4), which reports versions rather than mere presence, and reports them
  before the run rather than at its start.
- **`git checkout base && git pull --ff-only`.** The clone is refreshed by the
  sync layer.

---

## 10. Phasing

Each phase leaves the tree useful. Nothing here requires being half-migrated.

**Phase 0. Step outputs and interpolation** (§2). Prerequisite for everything.
No new capability, no new risk.

**Phase 1. The `executable` step** (§3), plus `pipelines:execute`, the instance
kill switch, audit, streaming, and the raised output and timeout caps. No secrets
yet. Delivers: inventory regeneration, `format:check`, `release:preflight`, and
any repo script, without a terminal.

**Phase 2. Secret injection, local runners only** (§4.1 to §4.5). Delivers: the
publish becomes possible at all. The auth mechanism is verified (§4.3.1), so the
open work is the injection path plus the **process-group kill fix in §4.5, which
is a hard precondition**: without it the "env dies with the process" guarantee
does not hold.

**Phase 3. The GitHub gates** (§6). `mergeStateStatus`, branch protection,
`pr-state-gate`, `staleness-gate`, hardened `checks-gate`, `merge` with the
head-SHA pin. Delivers: everything in the script except the bootstrap itself.

**Phase 4. `npm-bootstrap`** (§5). Delivers: the script, retired.

**Phase 5. Remote-runner secrets, resume-from-step, the repo lock** (§8.2, §8.3,
§4.4). Delivers: the same flow from any machine, and safe under concurrency.

Phase 1 is worth doing even if the rest is never built. Phases 3 and 4 are only
worth doing together; a merge step without the gates is a worse `gh pr merge`.

---

## 11. Plan of work

Ordered so every entry lands independently and leaves the tree green. There is no
test suite here, so "verify" means `pnpm typecheck` plus driving the real app
(see the companion-verification skill).

### PR 1. Kill the process group on timeout

Standalone bug fix, no dependency on anything else in this spec, worth landing
regardless. `modules/operate/src/exec/verify.ts`: add `detached: true` to the
spawn, replace `child.kill('SIGKILL')` with `process.kill(-child.pid, 'SIGKILL')`,
and guard against the child already being reaped.

Verify: set a repo verify command to something that backgrounds a long-lived
grandchild, force the timeout, confirm the grandchild is gone rather than orphaned.

Blocks: PR 4.

### PR 2. Step outputs and interpolation (Phase 0)

No migration needed: `pipeline_runs.steps` is JSON-as-TEXT
(`modules/code/src/api/pipelines-store.ts:160`) read through `safeParse`, so an
absent `outputs` on an old row is simply `undefined`.

- `contract/pipelines.ts`: `outputs?: Readonly<Record<string, string>>` on
  `PipelineStepResult`.
- `api/pipelines.ts`: `outputs` on `StepOutcome`; `completed:
  ReadonlyArray<PipelineStepResult>` on `StepContext`; the engine accumulates
  results and threads them.
- Extract the inline `.replaceAll('{{pr.number}}', …)` chain at
  `api/pipelines.ts:300` into a shared `interpolate(text, ctx)` helper and teach it
  `{{steps.<name>.outputs.<key>}}`. The `comment` step keeps working unchanged;
  this is the refactor that makes it reusable, and it belongs in its own commit
  before the feature that needs it.

Verify: a two-step pipeline where the second step's comment body references the
first step's output.

Blocks: everything below.

### PR 3a. The `executable` step, no streaming

- `RunnerBackend`: add `exec(cwd, command, opts)` alongside `verify`, generalizing
  it with an env overlay and a caller-supplied timeout. Implement on local and
  remote backends; keep `verify`'s `null`-for-old-runner convention.
- `contract/pipelines.ts`: `ExecutableStep` union member, zod schema,
  `PIPELINE_TYPE_STEPS` entry for all three types.
- `api/acl.ts`: `pipelines:execute`, granted to `admin` only. Explicitly **not**
  added to `maintainer`, which already holds `pipelines:manage` (§3.3).
- Module config: `allowExecutableSteps` boolean, default false.
- Engine: the handler, with `capture` producing outputs and `allowExitCodes`.
- Audit: record actor, pipeline, step, command, secret names, exit code.
- UI: step editor with the `[unsafe]` label and the permission/kill-switch state
  visible when the step is unavailable.

Output lands in `detail` for now, tail-clipped at the raised cap.

Verify: a `platform` pipeline running `pnpm packages:inventory` on octane.

### PR 3b. Streamed step output

New `SpaServerMessage` variant carrying run id, step index, and a chunk; today
the pipeline messages are only `pipelines.changed` and `pipelineRuns.changed`
(`modules/code/src/contract/index.ts:35`). Live output panel on the run view,
bounded tail persisted.

This is what makes PR 3a usable rather than merely functional. A five-minute
command with no visible progress is worse than the terminal it replaces.

### PR 4. Secret injection, local runners only (Phase 2)

Depends on PR 1 and PR 3a.

- `kind: 'secret'` config field for the npm token.
- Resolve at invocation into a fresh env object; never `process.env`, never the
  persisted run spec (§4.3).
- Extend `redactSecrets`
  (`modules/operate/src/exec/checkouts.ts:44`) with npm token shapes, and give the
  stream scrubber a **carry buffer** across chunk boundaries (§4.5). This is the
  subtle part of the PR and deserves the most attention in review.
- Refuse a secret-carrying step on a remote runner with a clear message.

Verify: a step echoing `${NPM_TOKEN:+set}` prints `set` while the value never
appears in output, run record, or audit; and confirm with `ps` during the run
that no argv carries it.

### PR 5. GitHub gates (Phase 3)

Split by concern, in order:

1. `mergeStateStatus` on `PrRecord` and in the sync path; branch-protection read
   on `GitHubClient` (`strict`, `enforce_admins`, `required_status_checks.contexts`).
2. `pr-state-gate` step: merged-first, then draft, then the bounded
   `mergeable: UNKNOWN` poll.
3. `staleness-gate` step: behind-count plus the file-overlap risk classification.
4. Harden `checks-gate`: `passed > 0` required separately, refusal on an
   unparseable list, per-name verification of required contexts.
5. `merge` step: squash, delete branch, optional `--admin`, head-SHA pin, and the
   pre-merge capture of the commits a bypass skipped.

### PR 6. `npm-bootstrap` (Phase 4)

The step from §5, with the count cross-check in TypeScript. Land the whole
`land-new-package` pipeline as a preset once it is green.

Retires `~/.claude/scripts/octane-merge-pr.sh`. Keep the script until the pipeline
has landed a real PR; the script is the reference implementation and the fallback.

### Deferred

Remote-runner secrets, resume-from-step, the per-repo publish lock, and the
runner capability probe (§8). None of them block landing a package by hand from
the local runner, which is the target.

### Calls made without asking

- **`module-code` owns the npm secret and the bootstrap step.** A separate
  `release` module for one step kind is premature; move it later if a second
  registry appears.
- **`pipelines:execute` is admin-only by default, not granted to `maintainer`.**
  Recoverable through a role grant if that proves too tight; the reverse is not
  recoverable.
- **PR 3 is split** so a working step lands before the UI work it needs to be
  pleasant.
