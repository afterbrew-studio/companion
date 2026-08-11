# Autonomous contributor lifecycle audit

Date: 2026-08-02
Branch: `feat/autonomous-contributor-lifecycle`
Scope: all 14 in-tree modules, with emphasis on webhook ingestion, issue triage,
long-running Board work, large-PR review, pipelines, authorization and the
governed/autonomous operating model.

This is a focused continuation of
[`maintainer-workflows-2026-08.md`](./maintainer-workflows-2026-08.md). That
audit covers the wider UI, paging, prompt-evaluation and application/package
surfaces. This document records the end-to-end contributor flow added and
pressure-tests whether it can run without a maintainer babysitting every step.

## Executive conclusion

Companion now has one coherent path from a GitHub event to an evidence-gated
decision:

```text
GitHub HMAC webhook
  → durable, idempotent delivery inbox
  → issue/PR/SHA subject lane
  → GitHub cache projection
  → optional issue/PR pipeline
  → issue triage
  → policy admission to Board
  → bounded implementation + local verification
  → PR
  → head-pinned, chunked AI review + adversarial verification
  → CI repair / review-feedback loop
  → human merge (governed) or policy-gated merge (autonomous)
```

The important property is not that the system can call an agent. It is that a
long-running action keeps its owner, authority, evidence version, budget,
progress and terminal state. Missing evidence, revoked permissions, a changed
PR head, an unavailable webhook, a daemon restart, unknown CI, a draft PR or a
context ceiling all stop or narrow automation; none is translated into
approval.

The branch is suitable for controlled personal use and governed pilot use. It
is materially safer for unattended operation, but the remaining P0/P1 items at
the end of this document still matter before advertising arbitrary-repository,
high-volume enterprise autonomy as hands-off.

## Why the pilot workload is a useful target

The pilot repository is a deliberately
difficult fixture: its queue changes while it is being measured and mixes
drafts, conflicts, generated/agent-labelled contributions and very large
cross-cutting changes. Two snapshots are kept separate here:

- the deterministic regression fixture (captured around 21:41 UTC) contains 49
  open PRs, 13 drafts, 28 `agent-authored` labels, 31 conflicts, 348,672 changed
  lines (median 967), 24 PRs at 1,000+ lines, seven at 10,000+ lines and 13
  touching 50+ files; its cached CI fixture has 33 failing, two pending and 14
  passing heads;
- the live Companion dry-run at `2026-08-02T22:10:48Z` already saw 50 open PRs,
  13 drafts, 29 `agent-authored` labels, 29 conflicts and 349,354 changed lines,
  while the four open issues included three unlabelled and all four unassigned.

The later live read was complete for all 50 PRs and four issues, started zero
agents/pipelines and made zero GitHub mutations. On a cold standalone client it
completed in about 4.7 seconds using two body-free GraphQL workload queries and
two REST governance reads; matching queries reported a combined cost of three
GraphQL units. It intentionally did not issue 50 extra CI calls: without a
current, head-matched Companion check cache all 50 CI states remained
`unknown`, which prevents an evidence-gate recommendation rather than turning
missing data green.

At that instant the deterministic lane order was 13 `wait-for-author`, 18
`repair-first`, one `map-and-split`, two `bounded-review`, 16 `standard-review`
and zero `evidence-gate`. Agent provenance was counted for transparency but did
not participate in lane selection; a regression test proves that adding only
the `agent-authored` label cannot change a lane or its reasons.

The default branch required strict `lint` and `typecheck`, but GitHub did not
require a review or conversation resolution, did not enforce protection for
administrators and allowed force pushes. No repository ruleset was present.
Those are warnings in a governed simulation, not invented proof that a PR is
bad. Every number above is a point-in-time observation—the increase from 49 to
50 PRs during this audit is itself evidence that a durable flow must pin every
decision to a head and observation time.

This shape rules out three tempting but unsafe designs: sending one full diff
to one model, treating green CI as proof of correctness, or spawning one agent
per PR without queue and cost controls. The implemented path handles the bulk
of this queue in bounded groups. For changes beyond the complete-review
envelope, it produces a metadata-guided architecture map and an ordered
review/split plan without claiming line coverage. That is useful partial
guidance, not a larger context window disguised as a complete review, so it can
never publish an approval or unlock an automatic merge.

## Operating modes

| Concern | Off | Governed | Autonomous |
| --- | --- | --- | --- |
| Webhook cache sync | available independently | on | on |
| Issue triage | optional granular switch | automatic | automatic |
| Apply triage labels | explicit policy and GitHub-write gate | optional | optional |
| Admit actionable issue | no end-to-end flow | backlog or ready queue | backlog or ready queue |
| Implement and locally verify | manual | automatic when queued | automatic when queued |
| Review and repair | manual/pipeline | automatic evidence, human decision | automatic evidence and remediation |
| Merge | human | always human | automatic only after all gates pass |
| Public GitHub writes | instance `agentGitHubWrite` policy still applies | normally `attended` | must be explicitly `allowed` |
| Revoked owner authority | action refuses | flow pauses/fails closed | flow pauses/fails closed |

Before saving either active mode, the Automations UI can simulate the current
repository. The dry-run reads exact open totals and a body-free bounded
projection (100 detailed PRs, 1,000 issues), repository merge settings, branch
protection and the most constrained observed rate budget. It checks the full
RBAC bundle, purpose-scoped account reach, Board availability, connected public
ingress, a confirmed healthy GitHub-side hook and the operator admission gate.
Crossing either detail ceiling, losing any size field or losing the forge makes
coverage explicitly incomplete and the result `blocked`; it never extrapolates
from the first page.

PR lanes use deterministic precedence: drafts wait, conflicts/current failing
CI repair first, changes outside the complete-review envelope map/split, large
but bounded changes use multi-slice review, and only current head-matched CI +
human approval + applied low-risk complete AI evidence may approach the final
evidence gate. A live `null` review decision cannot inherit an older cached
approval. The modal exposes every check, lane, reason, completeness bit and
rate observation while promising—and enforcing—zero agents and zero writes.

Mode alone is not authority. Enabling a flow validates the caller's complete
RBAC bundle, repository membership, purpose-specific GitHub accounts, push/admin
capabilities, public ingress and managed webhook. Every delayed stage then
revalidates live role/account/repository authority. The webhook installer never
lends its identity to the automation owner.

Automation ownership is also an offboarding boundary. A different profile
cannot silently inherit delayed work. A user with `users:manage` may use an
audited break-glass path to turn another profile's webhook, contributor flow or
switches off without borrowing that person's GitHub token. Taking work over is
a separate operation: it revalidates the new owner's own RBAC and GitHub access
and then records the new owner explicitly.

Workspace briefings follow the same rule. A daily/weekly schedule records one
owner, validates that profile's data permissions and fetch-account visibility
across every repository before saving, and rechecks live role plus private
workspace membership on every scheduler tick. A revoked or deleted owner pauses
the schedule with one rate-limited workspace notification and audit event.
Break-glass can always turn it off without a GitHub account; takeover validates
the administrator first. Each briefing now states cache freshness and names up
to ten stale/never-synced repositories instead of presenting old counts as
current evidence.

The policy is frozen onto each issue-created Board task. Changing a repository
from governed to autonomous later cannot silently grant an already-running task
permission to merge. Removing the flow can only tighten existing tasks: their
automatic merge flag is removed, never added.

## Webhook and issue flow

### Admission and durability

- The raw request is HMAC-SHA256 verified before parsing or acknowledgement.
- The delivered repository must match the configured receiver.
- GitHub's delivery id is the durable idempotency key.
- Only a bounded projection of fields Companion consumes is retained; the raw
  multi-megabyte body never enters the work queue or SPA.
- The job is persisted before GitHub receives `202`.
- Four workers run concurrently, but events are serialized per issue, PR or
  check SHA. One huge PR therefore cannot block unrelated contributors, while
  `opened → synchronize → checks` for the same subject cannot race.
- Retries use exponential backoff up to one hour and dead-letter after eight
  attempts. Processing leases recover after restart.
- Active admission is capped at 1,000 deliveries globally and 250 per
  repository. Capacity is checked in the same transaction as insertion; a
  signed new delivery receives `503` so GitHub retries it, while a duplicate of
  an already-durable delivery remains a successful `202`. Manual dead-letter
  retry goes through the same ceiling. Saturation raises a throttled operator
  notification and audit event instead of flooding either channel.
- A durable per-repository circuit breaker refuses new signed work with a
  retryable `503`, skips new scheduled repository work and returns `409` for a
  manual dead-letter retry, while already-durable delivery/Board/pipeline work
  keeps draining. Any workspace-scoped automation operator may pause with a
  recorded reason; only the owner or `users:manage` break-glass may resume
  foreign work. Pause/resume is audited and rendered optimistically with
  rollback, operator, timestamp and reason.
- Completed deliveries retain 30 days / 50,000 rows; failed deliveries retain
  90 days / 10,000 rows. Payloads are never returned by the public health DTO.
- The Automations page shows queued, processing, retrying and failed counts,
  current stage, last error and a scoped manual Retry action.

### Issue to task

An `issues.opened` delivery may first run an issue pipeline, then performs one
single-flight triage. Only configured `bug`, `feature`, `docs` or `chore`
verdicts are actionable. Invalid reports, questions, duplicates and issues that
need more information stop with a maintainer-visible verdict.

Actionable work is admitted idempotently by `(repo, issue number)` and carries:

- the source issue number and a bounded issue/triage briefing;
- the selected workspace and target branch;
- priority derived from triage severity;
- whether it enters Backlog or Ready;
- a frozen automation policy: review, merge method, CI repair and attempt
  ceiling;
- the profile that owns every delayed action.

Board ensures one developer and one reviewer worker exist for the workspace,
but it does not bypass runner policy or capacity. A task holds its worker across
review-feedback and CI-repair cycles so context is not reassigned arbitrarily.
Failures consume a bounded attempt budget and then land visibly in Failed.

## Pull-request review under context pressure

### Evidence planning

Review planning no longer materializes the whole patch before deciding whether
it is safe. A NUL-delimited `git diff --numstat -z -M` pass first produces a
filename/changed-line map, correctly handling spaces, tabs, newlines, renames,
binary files and mode-only changes. Single-pass patch loading also has a hard
child-process byte ceiling, so one minified/generated file cannot allocate the
historic tens-of-megabytes buffer before the service notices. Planning is
bounded by changed-file metadata, not diff bytes.

For an in-depth review:

- target group size is 1,200 changed lines;
- at most 12 groups are admitted;
- two groups run concurrently;
- each group receives only its path-limited patch, capped at 240,000 characters;
- each group has a 15-minute timeout;
- anchors are validated while that bounded group patch is in memory, so the
  service never reassembles all group patches merely to validate comments;
- up to 12 serious/uncertain findings are challenged by three independent
  verifier runs at a time;
- the aggregate reserves its summary call, allows at most 20 model calls, runs
  for at most 60 minutes and defaults to 2,000,000 input+output tokens;
- missing token telemetry fails closed rather than pretending the budget held.

A single oversized file, more than 12 groups, a character-heavy group, a failed
group or an unread file is explicit incomplete coverage. Incomplete review may
inform a maintainer but cannot auto-post or auto-merge. A requested in-depth
review therefore refuses safely; a high-level review of the same outlier runs a
bounded architecture pass over directory/path statistics, selectively inspects
at most 80 changed files and returns at most 12 coherent review/stack slices.
Only paths the model actually opened count as inspected, anchors are discarded,
the recommendation is forced to `comment`, and the UI labels the result
“guidance only”.

### Freshness and consequential actions

- Review evidence is pinned to the exact PR head SHA.
- A new push gets a distinct automatic-pipeline idempotency key and invalidates
  a pending old-head gate.
- Draft PRs wait without spending reviewer capacity.
- Automatic approval requires complete coverage, low risk, no unrefuted
  blocker/major finding and current passing CI.
- Unknown/no checks are not green. Failing checks route the Board task back to
  its bound developer when policy allows repair.
- Immediately before publication or merge, Companion fetches live PR/check
  state, rechecks owner authority and supplies GitHub's expected head SHA.
- The direct GitHub `PUT` merge enters the same instance write-policy choke
  point as comments/labels/reviews before network I/O. A repository response
  without explicit permission evidence degrades to `pull`, never `admin`.
- Board-owned PRs are excluded from generic repository PR automation so two
  reviewers or mergers cannot race and duplicate model spend.

Progress is durable and visible as `queued → planning → reviewing → verifying
→ summarizing → complete`, with completed/total groups, reviewed/total files,
message, child runs, token/call/deadline budget and aggregate Cancel. Cancellation
terminalizes the parent first, then stops queued/running children; late results
cannot revive it.

## Pipeline safety and composability

Pipelines now support PR-open, PR-update, issue and platform entry points with
inline or library-referenced steps. The critical invariants are:

- automatic PR runs are idempotent per pipeline, trigger and head SHA; manual
  reruns remain deliberate and repeatable;
- the complete resolved step graph is permission-preflighted before a run row
  is inserted, so an early label cannot succeed before a later unauthorized
  agent/merge step fails;
- live authority is checked again before every delayed side effect;
- agent, AI-review and Contribution Quality steps require both domain rights
  and `runs:read`/`runs:act`;
- webhook/background invocations refuse executable and npm-publish steps;
- an auto-run pipeline cannot be saved with executable/publish steps, including
  through a library reference, and a referenced definition cannot later be
  upgraded around that rule;
- command execution remains behind instance config plus separate execute and
  author-execute permissions;
- cancellation owns every queued/running child, durable log tail and terminal
  compare-and-set transition;
- list records stay light; detailed evidence/logs are fetched only for the
  expanded execution.

When Contribution Quality is enabled, the OSS preset screens it before paying
for review and does not post automatically. The internal preset orders quality,
current CI and an evidence-backed review. If an optional step owner is absent,
the step is omitted and the UI reports that explicitly rather than implying the
gate ran. Watch mode starts nothing. Presets remain starting configuration, not
hidden policy.

## Module-by-module assessment

| Module | Role in the lifecycle | Assessment and remaining pressure |
| --- | --- | --- |
| `core` | Identity, sessions, roles, central RBAC and audit | The central router remains the single request authorization/audit choke point. Long-running work now also rechecks the owner's live role and disabled state. Audit forwarding/retention support governed use. Remaining: forwarding-lag health and custom-role maturity. |
| `workspace` | Repository/workspace scope, reports and durable inbox | Every flow is bound to one workspace even when a repo belongs to several. Notifications expose blockers/dead letters without coupling source actions to delivery. Remaining: richer automation-SLO dashboards and visible acknowledgement failures. |
| `admin` | Instance/module/config control | Correctly thin; exposes the policies that govern agents and modules rather than duplicating them. Remaining: consistent restart-required state and typed confirmation for destructive control-plane actions. |
| `operate` | Queue, runners, worktrees, run ownership, policy and budgets | Run creation, interaction, events and periodic reconciliation all enforce live owner authority. Read-only vs workspace-write access, reserved automation capacity, protected branches, per-run/monthly budgets and self-managed/relay webhook ingress support both editions. Review planning now avoids full-diff allocation. Remaining: runner leases/version negotiation, cancellation SLOs and exact billed/cache-aware cost. |
| `code` | GitHub cache, accounts, issues, PRs, triage, review, fixes and pipelines | This is the decision engine: purpose-scoped personal credentials, head-pinned complete coverage, adversarial findings, current checks and preflighted pipelines. Oversized high-level review returns an explicitly partial architecture/change map and split plan. The autonomy snapshot uses body-free GraphQL instead of one detail request per PR; concurrent purpose checks single-flight the same account/repository probe, and missing permission evidence is read-only. UI AI controls require the same run capabilities as the API, while ordinary GitHub actions and pipeline rights remain independent. Maintainer filters use one JSON-scoped repository argument rather than hitting SQLite's variable ceiling; review decoration batches large sets; scheduled merge/briefing reads exclude closed PR history. Remaining: recursive execution of approved map slices, GitHub merge-queue integration and fleet-level secondary-limit/cost telemetry. |
| `plan` | Proposals, living specs and repository documentation | Supplies bounded grounding to agents and can check spec drift after merge. Generation routes now require run rights as well as plan rights. Remaining: make long document generation granular/retriable and measure retrieval freshness. |
| `board` | Durable issue→implementation→review→repair→merge state machine | Source-issue provenance, idempotent admission, frozen policy, live authority, local verification, draft/CI/material-finding gates and bounded attempts make it the long-running backbone. Remaining: lease/duplicate-work chaos tests and bounds for extremely large simultaneously-active boards. |
| `automations` | HMAC receiver, durable reactor, schedules and AI Help | Owns the contributor-flow policy, subject-laned delivery inbox, retries/dead letters, hard ceilings, repository circuit breaker, read-only readiness simulation, health UI and fail-closed reconciliation when Board/workspace/webhook disappears. Audited break-glass disable/takeover cover repository work and workspace briefings without identity borrowing. Delivery health batches very large workspace scopes; account probes are bounded/single-flight; auto-merge uses a fair 20-candidate window across at most four repositories concurrently. Webhook secrets stay server-side; enterprise may supply its own HTTPS public URL, while an active flow requires a confirmed GitHub-side hook. Remaining: sustained load/chaos evidence, richer SLO dashboards and narrower typed AI Help capabilities. |
| `refinement` | Human-reviewed epic decomposition | Useful governed staging before Board: read-only decomposition, uncertainty, dependencies and explicit import. It is intentionally not forced into every issue flow. Remaining: optionally route high-risk/large triage into refinement automatically and score task-size/dependency quality. |
| `planner` | Guided idea discovery into proposal/refinement/Board | Valuable before code exists; agent actions now align with run permissions and recover durable sessions. Remaining: step-level retry/cancel and compaction-quality measurement. |
| `slop` / Contribution Quality | Cheap evidence/value/risk/reviewability screen | AI provenance is separated from value. Partial evidence cannot become a confident close recommendation; positive and negative factors stay inspectable. Pipeline permission preflight includes Slop rights. Remaining: calibrate on labelled repositories and post-merge outcomes; finish neutral internal naming. |
| `playground` | Prompt/model regression and pipeline preview | Exact production adapters, immutable adversarial cases and a durable budgeted release gate make prompt changes testable instead of intuitive. Agent actions now require run capabilities. Remaining: gate prompt/model promotion automatically and add repository-specific labelled corpora. |
| `notify` | Deliver durable inbox events to external channels | Source operations never depend on delivery success, which is correct for autonomy. Remaining: pin validated DNS addresses through connect to close rebinding, then add bounded delivery concurrency/dead letters and SLOs. |
| `oidc` | Enterprise identity provider | Provides governed account lifecycle without adding per-request auth paths. Remaining defense in depth: nonce/JWKS signature verification, discovery cache/rotation policy and clock-skew tests. |

Slim now includes the eight modules needed for a useful contributor lifecycle:
Core, Workspace, Operate, Code, Admin, Plan, Board and Automations. Full adds the
six optional refinement, evaluation, quality, notification and enterprise
identity modules. Optional modules still fail visibly or are omitted through
declared soft dependencies; pipelines do not retain dead step references.

## UX and operator journey

The maintainer should not need an agent transcript to understand work:

1. Automations shows whether ingress is off, relay-backed or self-managed,
   whether the managed GitHub hook is healthy and which profile owns the flow.
2. Enabling a flow validates all capabilities before saving; the UI names
   missing permissions and still lets a demoted owner or an authorized
   break-glass administrator turn unsafe automation off. A takeover is labelled
   and cannot reuse the former owner's GitHub identity.
3. “Dry-run current backlog” opens a zero-write/zero-agent modal with live
   readiness checks, exact completeness, rate budget, workload metrics, lane
   counts and per-PR reasons. Refresh keeps the previous result dimmed while
   loading; failure offers an explicit retry.
4. Every repository exposes a reasoned admission circuit breaker. Optimistic
   pause/resume rolls back on error and explains that new webhooks/schedules
   stop while already-durable work drains.
5. Workspace briefing shows whether it is off, owned by the caller, paused for
   a missing owner or eligible for audited administrator takeover. Optimistic
   cadence changes roll back on failure; manual send and active cadence options
   explain missing permissions.
6. Delivery health shows the current stage and actionable failed rows.
7. Issue triage, Board cards, pipelines and PR review each render durable phase,
   progress, retry/cancel and terminal error state.
8. AI actions appear only with domain plus run authority. Read-only users may
   inspect authorized run evidence without receiving Cancel/Ask controls.
9. Contribution Quality explains value/evidence/risk separately from AI
   provenance, reducing the chance that maintainers automate prejudice instead
   of quality control.
10. Oversized review results are marked “guidance only”, name inspected versus
   total files and expose the proposed review/stack order without enabling
   Publish or Merge.
11. AI Help is a right-side drawer and remains a secondary surface rather than
   displacing primary navigation/content.

The remaining UX gap for pilot-scale outliers is turning the review map into an
interactive execution plan: let the maintainer approve/reorder slices, run a
bounded review for one slice, and carry verified evidence forward without
rerunning the whole PR. The current map makes the outlier actionable, but it
does not yet orchestrate that follow-up automatically.

## Residual risks and recommended order

### P0 before broad unattended production

- Add load/fault tests for webhook storms, SQLite busy/disk-full, process kill
  at every delivery/Board/pipeline transition and duplicate runner completion.
- Prove merge behavior against protected branches, required checks, required
  reviews and GitHub merge queues on a real staging organization. Keep the
  current no/unknown-CI refusal.
- Exercise GitHub App installations at organization scale, including token
  rotation, secondary rate limits, installation removal and partial outages.

### P1 reliability, security and reviewer throughput

- Make huge-PR map slices executable and resumable while preserving the rule
  that sampled/high-level evidence cannot claim complete coverage.
- Add step/group retry from durable evidence rather than rerunning an entire
  expensive review or pipeline.
- Add runner lease/version negotiation and chaos tests for disconnect,
  reconnect, lost WebSocket events and late completions.
- Replace broad trusted AI Help REST authority with typed tools and explicit
  per-action capability/confirmation envelopes.
- Move GitHub PATs, GitHub App private keys/cached installation tokens and
  webhook HMAC secrets behind the dynamic `ctx.secrets` provider. Persist only
  opaque references and health metadata in domain tables, with additive
  migration and rotation support for existing installations.
- Pin outbound notification connections to the already-validated DNS address;
  add OIDC nonce/JWKS validation.
- Promote the point-in-time GitHub rate budget already shown by repository
  dry-runs into fleet-level operational health, alongside queue age, retry age,
  dead-letter count, runner saturation, review cancellation latency and cost.
- Add server-side paging to the remaining repository/report catalog endpoints.
  Permission probes are concurrency-bounded and SQLite-safe now, but a very
  large installation can still return an unnecessarily large JSON response.

### P2 learning and product refinement

- Calibrate Contribution Quality and review confidence against maintainer
  overrides, post-merge regressions, reverts and security incidents. Acceptance
  alone is not ground truth.
- Make a current green Playground release gate a configurable prerequisite for
  changing production prompt/model pins.
- Route selected high-risk or cross-cutting issues through Refinement/Plan
  before Board admission.
- Add contributor-facing evidence requests and split proposals so a rejected
  automation decision teaches the author how to make the change reviewable.

## Verification record

Checks completed while producing this audit:

- the full root `pnpm test` passed across all workspace packages and modules;
- Operate passed 300 tests, including real-Git rename planning and a bounded
  giant-diff child process;
- Code passed 170 tests, including automatic admission failures, head-pinned
  review gates, cancellation races, oversized change-map bounds, purpose-probe
  single-flight and the central direct-merge write gate;
- Automations passed 35 focused tests, including durable deduplication,
  saturation/503 alerting, restart recovery, subject ordering, admission pause
  and resume, manual-retry backpressure, complete read-only dry-run coverage,
  schedule authority and break-glass ownership;
- Board contributor-flow/policy/lifecycle, Core raw-router, Slop quality,
  Playground release-gate and CLI profile suites passed inside the root run;
- root `pnpm typecheck`, `pnpm acl check --strict` (48 permissions, zero
  errors/warnings) and `git diff --check` passed;
- the CLI test built the complete 14-module production profile successfully;
- the slim eight-module production profile built successfully, including the
  Vite application bundle;
- an isolated 13-module daemon booted cleanly (OIDC intentionally omitted
  without issuer/client configuration). Authenticated API smoke tests covered
  module/workspace catalogs plus contributor flows, delivery health, Board,
  pipelines, planning, evaluation/quality surfaces and the briefing lifecycle
  `off → daily(owner) → send now → off`.
- a second isolated slim-profile daemon installed Plan, Board and Automations
  through their real authenticated module APIs, created a local workspace,
  connected and cloned the pilot repository, and returned a complete live governed
  dry-run at `2026-08-02T22:20:31.737Z`: 50 PRs, four issues, 349,587 known
  changed lines, eight current cached passing heads, 17 failing and 25 unknown.
  It correctly reported `blocked` solely because public confirmed webhook
  ingress was absent, with zero GitHub mutations and zero agent runs. The same
  instance paused and resumed repository admission through the public API; the
  migration-backed row existed while paused, was removed on resume, and all
  three actions (dry-run, pause and resume) appeared in the audit log. The
  daemon then shut down cleanly and its isolated temporary home was moved to
  Trash.

The in-app browser connector exposed no browser backend, so the visual pass was
driven directly through local headless Google Chrome and its DevTools protocol
against a signed-in isolated production build. At 1440×900 and 390×844 it
rendered the governed editor, circuit breaker, dry-run skeleton, complete live
result, and AI Help drawer with no JavaScript exceptions or horizontal
overflow. The drawer measured 416 px against the desktop right edge and the
full 390 px mobile width. Closing moved it from 0% through 76.9% to 100% beyond
the right edge before visibility became hidden. This pass found and fixed a
real Tailwind 4 animation bug: `translate-x-*` changes the individual
`translate` property, which was absent from the original transition list even
though `transform` was present. The remaining limitation is breadth: this was
a targeted journey through the changed autonomy surfaces, not a screenshot of
every legacy page or a substitute for the staging GitHub/IdP/runner failure
drills listed above.
