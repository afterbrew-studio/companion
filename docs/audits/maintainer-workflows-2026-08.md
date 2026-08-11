# Maintainer workflow, reliability, performance, and UX audit

Date: 2026-08-01<br>
Scope: every in-tree Companion module, the daemon, SPA, runner, CLI, and static landing page

## Executive conclusion

Companion has the right architectural foundation for an AI-era maintainer tool:
GitHub remains authoritative, cross-boundary DTOs are centralized, mutations are
permissioned and broadcast, agent work is isolated, and most AI actions already
follow review-then-apply. The largest risk was not the modular architecture. It
was that several failure paths could make incomplete or stale evidence look like
a completed decision:

- a partial large-PR review could be presented or posted like a full review;
- a review or merge decision could outlive the PR head commit it examined;
- retried webhook deliveries could start duplicate pipelines;
- an interrupted daemon could leave reviews, triage, and pipelines permanently
  running;
- nominally read-only agents still had write-capable execution backends;
- provenance/AI-likelihood was too easy to conflate with contribution quality;
- some UI failures looked like legitimate empty states.

The branch closes those critical gaps. The resulting safety rule is:

> Companion may automate collection and analysis aggressively, but it may only
> automate a consequential decision when the exact head commit, complete
> evidence coverage, required checks, and action policy are all proven.

AI authorship is deliberately not a rejection criterion. The classification now
separates provenance from value, correctness, test confidence, technical risk,
and reviewability. A well-tested AI-assisted PR can be valuable; an untested
human-written PR can still need evidence.

This branch materially improves the product, but it is not the end state. Exact
production-prompt adapters, an eight-case frozen adversarial corpus, and a
durable release gate now sit on top of the evaluation harness. Pipeline runs
also have bounded durable output, owner-scoped live delivery, reconnect replay,
and atomic cancellation of queued/running children. Review token use is folded
from live provider events and reconciled at child completion. The remaining
priorities are calibrating the corpus on labeled real outcomes, wiring the gate
into prompt/model promotion, adding actual billed/cache-aware currency ceilings
where runtimes can report a complete bill, step-level retry, fault injection at
state-machine boundaries, and additional hardening of the trusted assistant and
outbound DNS boundary. Flood-facing PR/issue/quality/run/planning collections
now have bounded server pages and lightweight list DTOs; the main remaining
volume risks sit in control-plane administration, active-board cardinality, and
deep single-record histories rather than primary maintainer queues.

## The maintainer decision flow

The intended funnel is now:

1. **Ingest once.** Verify the GitHub HMAC, validate the repository, and record
   the delivery before doing expensive work.
2. **Pin the subject.** Every review, check snapshot, pipeline, and merge is tied
   to a PR head SHA. A new push invalidates an old conclusion.
3. **Collect deterministic facts.** Changed-file sizes, diff coverage, GitHub
   checks, mergeability, contributor relationship, commit metadata, and repo
   policy are facts. The model may interpret them but may not invent them.
4. **Classify quality independently from provenance.** Score value, evidence,
   technical risk, test confidence, and reviewability. Treat AI-likelihood only
   as a weak contextual signal unless it combines with concrete quality defects.
5. **Plan the context.** A small PR gets one bounded review. A large PR is split
   into coherent file groups. A single file that cannot fit is explicitly
   unreviewable instead of silently truncated.
6. **Review with visible coverage and limits.** Persist the phase,
   completed/total groups, current message, child run IDs, reviewed/total files,
   aggregate call use, and hard deadline after every stage. Let the maintainer
   cancel the aggregate, including queued and active children.
7. **Synthesize conservatively.** Missing groups, unread files, unknown CI, or a
   parsing failure make coverage partial/error. They never become an approval.
8. **Verify high-impact findings.** Independent verifier runs challenge a bounded
   set of serious findings and may confirm or refute them.
9. **Require an action-safe state.** Automatic posting is limited to complete,
   low-risk, green evidence. Merge and pipeline actions re-fetch live GitHub state
   and use the expected head SHA.
10. **Learn from human decisions.** Included/dropped findings and reasons are
    retained. The next step is to connect them to post-merge outcomes so model
    confidence can be calibrated against reality rather than acceptance alone.

## PR classification model

The quality assessment carried by Slop Detection and the pipeline quality gate
now has independent dimensions:

| Dimension | Values / scale | What it answers |
| --- | --- | --- |
| Quality class | `valuable`, `promising`, `needs_evidence`, `low_value`, `unsafe` | Is the change worth maintainer attention and possible integration? |
| Value | 0–100 | Does it solve a concrete user/maintainer problem relative to its maintenance cost? |
| Evidence | 0–100 | Are the claims supported by code, tests, CI, reproduction, or measurements? |
| Technical risk | low / medium / high / critical | What is the impact and likelihood of a correctness, security, or operational failure? |
| Test evidence | strong / partial / weak / none / unavailable | Do tests exercise the changed behavior and meaningful failure modes? |
| Reviewability | ready / needs split / blocked | Can a reviewer make a reliable decision from the available scope and artifacts? |
| Provenance | factual signals plus AI likelihood | Who/what may have produced it; never a quality verdict by itself. |
| Decision factors | positive/negative/neutral evidence | The concrete facts that caused the classification. |

Important policy details:

- Incomplete diff evidence forces `needs_split`, caps evidence confidence, and
  cannot produce `valuable`/`promising` or an automatic close recommendation.
- `close` is reserved for confirmed low-value throwaway work or a concrete
  unsafe change. Missing proof normally means ask for evidence, not punish.
- A polished description, a large diff, an AI trailer, or a new account is not
  proof of value or harm.
- Clean long-standing contributor provenance is positive context; unavailable
  provenance produces no signal rather than an implicit outsider penalty.
- The UI shows the classification, the component scores, reviewability, and both
  positive and negative factors so the maintainer can challenge the conclusion.

## Large-PR and context-overflow behavior

The review path now uses bounded server-created evidence instead of telling an
agent to discover the diff with shell commands:

- default group budget: 1,200 changed lines;
- maximum groups: 12;
- group concurrency: 2;
- group timeout: 15 minutes;
- hard prompt-diff ceiling: 240,000 characters;
- independent finding verifications: at most 12;
- aggregate agent-call ceiling: 20, with the summary call reserved before
  verifiers are scheduled;
- aggregate wall-clock ceiling: 60 minutes, including queue and preparation;
- configurable aggregate input + output token ceiling: 2,000,000 by default;
- cumulative provider usage is folded live using monotonic per-run snapshots,
  then reconciled exactly once when each child settles; list-price cost comes
  from Operate's single pricing table and unpriced spend is marked as partial;
- a runtime that cannot provide usable token telemetry stops the aggregate
  instead of letting a blind counter claim that spending is bounded;
- oversized single files are rejected as not safely reviewable;
- unread/missing files are named in synthesis and make coverage incomplete.

The durable progress state is `queued → planning → reviewing → verifying →
summarizing → complete`, with completed/total units, a current message, coverage,
aggregate budget/deadline, and all child run IDs. The SPA renders a determinate
accessible progress bar, links to the active runs, and exposes aggregate cancel.
Cancellation terminalizes the review atomically before removing queued jobs and
stopping active runs, so a late child cannot publish findings into a cancelled
row. On restart, stale running records are terminalized instead of hanging
forever.

This is intentionally conservative. It prevents context overflow and runaway
fan-out from becoming false confidence or unbounded work. Token enforcement now
happens after every persisted provider-usage event rather than waiting for child
completion. The event that crosses the ceiling, and responses already in flight
in sibling runs, can still create a bounded overshoot before cancellation lands;
that limitation is stated in settings. Exact per-review currency enforcement
remains follow-up work for runtimes/models whose actual price or cache usage is
not reported; the UI shows known list-price cost as a lower bound rather than
inventing a complete bill.

## Changes delivered by this audit

### Review, triage, and prompts

- Review placeholders and progress are persisted before asynchronous work
  starts; every terminal path records success/error and broadcasts it.
- One review is single-flight per PR and has a 20-call/60-minute aggregate
  budget plus a configurable aggregate token ceiling. Maintainers can cancel
  it; queue and active runs are both stopped.
- Every persisted provider response contributes a monotonic cumulative token
  snapshot and centralized list-price cost while the review is running. Child
  settlement performs one final reconciliation without double counting.
  Missing telemetry fails closed, late sibling usage is folded into the terminal
  record, and live/terminal UI exposes the same budget. Budget broadcasts and DB
  writes are coalesced to at most once per second except at the exact threshold.
- Terminal review transitions are compare-and-set. Late run starts/completions
  cannot attach runs or findings after cancellation, and human inline drafts are
  moved to a publishable draft rather than orphaned.
- Large reviews record full/partial/error coverage and cannot auto-publish when
  incomplete. Failed chunks are not silently converted into success.
- Findings are persisted and shown as soon as each bounded review group
  finishes. A pipeline with explicit GitHub posting enabled publishes anchored,
  ready findings progressively; serious or uncertain claims wait for the
  independent verifier, and the aggregate verdict is posted only after the
  complete review. Manual AI reviews retain review-then-apply.
- Human draft findings survive a replacement AI review.
- Review findings remain strings when anchoring is impossible, rather than being
  discarded.
- Review posting rejects stale head SHAs and incomplete agent coverage.
- Triage now has durable running state, preflight checks, crash recovery, and a
  server-derived loading/progress state.
- Review, triage, planning, digest, playground, and classification prompts state
  the trust boundary: PR text, repo files, comments, docs, and quoted rules are
  untrusted evidence and cannot override system instructions.
- Prompts require file/test evidence, counterevidence, uncertainty, and explicit
  missing coverage. Read-only runs consume a server-built bounded snapshot/diff.
- Parsed review, triage, and contribution-quality output has hard per-field and
  collection limits before it can reach SQLite or a maintainer's browser.

### Pipelines and automation

- Pipeline history snapshots the workspace and pipeline name, so deleted/edited
  definitions do not rewrite history.
- Webhook-triggered runs use a semantic idempotency key including pipeline,
  target, trigger, and PR head. Manual reruns remain possible.
- A unique partial index makes duplicate prevention atomic at the store boundary.
- Pipeline, triage, and review crashes are recovered to terminal states at boot.
- Pipeline cancellation terminalizes the SQLite row before reaping queued or
  running agent/command children. Compare-and-set updates prevent a late child
  from reviving it, and a declined/expired approval is an explicit cancellation
  rather than a false successful run.
- Normal module shutdown snapshots the newest throttled output, marks active
  rows interrupted, then stops their children. Run ownership is durable, and
  pipeline approval/cancel/log routes revalidate both workspace and personal
  repository access.
- Executable/bootstrap output is scrubbed before transport, sequence numbered,
  and retained as a 64,000-character tail per step. History lists omit those
  heavy blobs; one run detail and one step-log endpoint provide bounded replay
  after refresh/reconnect without turning the list feed into an N+1 transfer.
- Raw WebSocket output is owner-only. Other authorized maintainers receive the
  same persisted evidence through authenticated REST instead of inheriting the
  initiating maintainer's personal credential boundary.
- Cancellation is rechecked immediately before any later GitHub post, label,
  comment, PR repair action, or merge, so evidence that finishes late cannot
  start a new external mutation after Stop.
- PR repair and failed-check analysis actions expose their child run before its
  first prompt and participate in the same cancellation tree; cancelling during
  clone/worktree preparation stops the late-created child before it can begin.
- Issue/platform pipeline agent steps receive disposable base worktrees rather
  than a mutable checkout.
- AI review steps fail when coverage is incomplete, the review errored, or the
  requested post failed.
- A reusable PR quality-gate step/preset is available before expensive review or
  merge stages.
- Automation timers are single-flight and cleanly stopped. Schedule cursors only
  advance after success.
- One inaccessible auto-merge candidate no longer aborts the rest of a
  repository sweep.
- GitHub delivery IDs are recorded with stale recovery and bounded retention.
- Auto-merge re-fetches the live PR, checks, review, and head immediately before
  merging; the GitHub merge call includes the expected SHA and verifies GitHub's
  merged response.

### Execution isolation

Agent runs carry an explicit access class through daemon, local backend, remote
runner protocol, and harness:

- `read-only`: analysis/review/triage/report work;
- `workspace-write`: implementation work in its isolated workspace;
- `trusted-assistant`: the deliberately privileged interactive platform helper.

Codex uses read-only/workspace-write sandboxes with approval disabled, and only
the trusted assistant receives the dangerous bypass. Claude read-only runs allow
only read/search tools. Moxxy read-only policy denies write/edit/shell/network/
browser/dispatch/skill-loading requests and the orchestrator fails closed for an
unknown permission request. Tests exercise the mapping and harness arguments.

This is a major reduction in blast radius. `trusted-assistant` remains a named
exception and deserves a smaller capability API rather than broad local REST
access in the longer term.

### State, security, and data correctness

- Notification read state is per user; one maintainer cannot clear another's
  inbox. The client updates read state optimistically and reconciles by WS/API;
  read-all uses indexed keyset pages and bounded receipt queries rather than one
  SQLite-variable-heavy request.
- Personal outbound notification targets reject private, loopback, link-local,
  documentation, and otherwise non-public resolved addresses, including across
  redirects. Redirects are followed manually and revalidated.
- OIDC requests have a 15-second timeout, bounded pending-state storage,
  mandatory token expiry, live config fingerprint refresh, and escaped callback
  output. Callback targets are validated same-origin paths and reject URL-parser
  backslash/control tricks.
- Failed audit forwarding retains the oldest unsent batch instead of skipping it.
- Audit export streams paged rows with backpressure rather than building the
  entire export in memory, and stops waiting when a client disconnects.
- The notify routes now enforce the personal-vs-admin ACL intended by the
  contract.

### UI and maintainer experience

- Running reviews show the phase, determinate group progress, file coverage, and
  child-run links, aggregate call/deadline budget, and a cancel action.
- Failed/cancelled reviews offer an immediate retry path, while cancellation is
  reported separately from agent failure and pending maintainer work.
- PR/Issue initial-load failures have a dedicated explanation and Retry action;
  they no longer simultaneously display raw fetch text, zero-count tabs, and an
  empty-state claim.
- First-load skeletons do not claim `0` counts before data exists.
- The Issues empty state distinguishes no connected repos from connected repos
  that simply have no matching issues.
- PR review breadcrumbs correctly recognize the `/review` route. Mobile
  breadcrumbs no longer overlap.
- The review progress bar exposes `role=progressbar` and numeric ARIA values.
- Huge finding lists render 20 detailed cards initially and load 20 more on
  demand. A real 91-finding review fell from roughly 2,570 page elements to 945
  on initial render while retaining the full selection count and diff focus.
- Notification acknowledgement is visibly immediate and is persisted per user.
- The password-change form now exposes the standard username/current-password/
  new-password autocomplete relationship.
- Pipeline creation/run dialogs remain open on a failed submit so input and the
  error are not lost.
- PR, issue, and workspace pipeline histories now share one expandable run
  surface with phase summaries, live duration, explicit stopped state, Stop
  control, loading/error recovery, and persisted command output. Only the
  initiating owner receives zero-latency stdout; every authorized viewer gets
  two-second active polling and reconnect reconciliation without duplicate
  chunks or forced scroll-to-bottom.
- Pipeline and issue hooks reject out-of-order responses when the workspace or
  issue changes. Definition failures no longer render a false “no pipelines”
  state, retained logs can be expanded beyond the latest 400 lines, and a
  terminal transition performs one final replay so non-owners do not miss the
  last sub-poll output flush.
- Issue, PR, contribution-quality, proposal, specification, documentation,
  idea, refinement, completed-board, and Agent Run queues are server-paged and
  searched in SQLite. List DTOs omit issue/PR bodies, document/spec markdown,
  refinement stories, completed-card detail, run cwd/outcome/verification, and
  other terminal evidence that belongs on detail.
- Exact queue totals no longer depend on how many rows the browser happened to
  load. First-page-only facets and page-local triage/review enrichment avoid
  recomputing metadata for the entire workspace on every scroll.
- Agent Runs expose URL-backed search/filter state, honest first-load/error/
  empty states, incremental loading, and live gateway state only for the visible
  page. High-frequency run broadcasts are coalesced to at most one list reload
  per second; active-run widgets filter before applying their bounds.
- The neutral user-facing surface is now **Contribution Quality**. Its radar
  orders actionable assessments by technical risk, value class, and missing
  evidence rather than treating AI-likelihood as a quality score.

### Production prompt release gate

- Owning modules register server-only adapters for the exact production prompt
  builder, parser, task id, and parser-contract version; executable prompt code
  never crosses to the browser.
- The eight immutable cases cover an authorization bypass hidden behind passing
  CI and prompt injection, plausible issue reports missing evidence, fair
  treatment of a disclosed AI-assisted tested fix, a clean one-line boundary
  fix that must not become a false positive, polished test theatre masking an
  authorization bypass, a partial huge diff that must remain undecided, planner
  convergence at an exhausted question budget, and actionable refinement
  decomposition.
- Every replay records the fixture revision, adapter version, exact prompt hash,
  model/lane configuration hash, actual runner/model/harness, deterministic
  parser/assertion checks, resource usage, and a bounded answer snapshot.
- A prior pass becomes stale after any fixture, parser contract, prompt text, or
  current model/lane-setting change. Never-run and stale safety cases block the
  gate instead of inheriting a green state.
- The eight-case gate is a durable server-owned suite. Seven safety-critical
  cases require two consecutive current passes, so a full gate is an explicit
  15-run execution plan and one stochastic pass cannot turn it green. Navigation
  does not stop it; progress survives refetches, cancellation terminalizes the
  suite before stopping queued/live work, failures are isolated per case, and
  daemon restart turns an abandoned `running` record into an actionable
  `interrupted` result.
- The whole suite has one live 1,000,000-token and 60-minute budget. Cumulative
  provider events are folded monotonically, settlement cannot double count, and
  missing telemetry fails closed. The crossing snapshot is durable before child
  cancellation; shutdown now also awaits the detached suite task before stores
  can close.
- Suite and replay history are private per maintainer, single-flight per owner,
  compare-and-set at terminal transitions, and bounded in SQLite.

## Module-by-module assessment

| Module | Assessment after this branch | Main remaining work |
| --- | --- | --- |
| `core` | Central auth/RBAC boundary remains coherent. Audit forwarding no longer skips failed batches; export is streamed; profile form accessibility fixed. | Split the 593-line route surface, test stream cancellation/client disconnects, and expose delivery lag/failed-forwarding health. |
| `workspace` | Workspace scoping is consistent; notification receipts are per-user and optimistic, and bulk acknowledgement is keyset-paged. Reports/inbox looked coherent on desktop/mobile. | Add notification mutation error feedback and interactive inbox pagination; keep the existing 30-day retention observable. |
| `admin` | Thin, appropriately reuses core permissions. Settings/modules/users/roles journeys are clear. | Destructive/restart operations should use a consistent typed confirmation and visible restart/reconnect state. |
| `operate` | Strong queue/run/worktree model and explicit end-to-end access classes close the largest execution-policy gap. Agent Runs is now a lightweight, user-private, workspace-scoped server queue; terminal evidence stays on detail, active filtering happens before bounds, and bursty events are coalesced. | `orchestrator.ts` and `runners-registry.ts` remain stability hotspots; add cancellation SLOs, lease/heartbeat telemetry, narrow trusted-assistant capabilities, and retire the capped full-record compatibility list after external consumers migrate. |
| `code` | Most critical path is substantially safer: SHA pinning, complete-coverage gates, durable review/triage progress, bounded context, live aggregate review call/time/token enforcement with cancel/retry and cost visibility, plus pipeline idempotency, bounded replay, cancellation, restart recovery, and clearer failure UI. PR/Issue queues now page body-free projections with exact totals and page-only enrichment. The diff browser requests 50-file pages independently of full AI-review coverage, retains at most three pages, caps renderable patch text at 400k characters, labels page-local totals, and preserves/retries the prior view on upstream failure. | Decompose the largest services/routes, add actual billed/cache-aware currency telemetry, add group/step-level retry, resolve a selected finding directly to its changed-file page, and expose aggregate GitHub rate-limit/backpressure telemetry. |
| `plan` | Proposal/spec/doc analysis is read-only, uses disposable worktrees/server snapshots, and has explicit untrusted-context prompts. Proposal, spec, and doc cards are server-paged lightweight rows; markdown/analysis loads only on detail, and selectors use bounded options. Start failures roll back cleanly. | Long documentation generation needs durable granular progress/cancel/retry; measure retrieval quality and staleness, and add cursor paging if offset depth becomes material at six-figure collections. |
| `automations` | Single-flight scheduling, delivery ledger, correct cursor semantics, live pre-merge checks, and clean shutdown materially improve stability. | Assistant sessions remain the broadest privilege boundary; add per-automation run history, reason codes, rate-limit backoff visibility, and operator pause/circuit-breaker controls. |
| `board` | Old-head/incomplete reviews cannot route or merge a newer PR. Active work remains visible as one board while the Done archive is independently paged; list rows strip descriptions, acceptance text, and attachment bodies. Worker-gating empty states are understandable. | `Board.tsx` and the service need decomposition; a workspace with an extreme number of simultaneously active cards can still produce a large board. Add lease-expiry/duplicate-work chaos tests and make transient slot use less confusing. |
| `slop` | Reframed in the UI as **Contribution Quality**: an evidence-backed assessor preserving provenance as context, never a verdict. The workspace queue is server-paged/searchable/filterable and the radar prioritizes risk/value/evidence. Partial evidence is forced conservative. | Calibrate thresholds on labeled PR corpora, record false-positive/false-negative and post-merge outcomes, complete internal terminology migration, and support repository-specific policy packs. |
| `planner` | The idea journey validates typed output, derives progress, recovers working sessions, and uses read-only analysis. Idea cards are paged summaries; usage/history retention and event reads are bounded, old sessions compact, and proposal status counts avoid loading analyses. | `Idea.tsx` remains the largest UI hotspot; add step-level cancellation/retry, measure compaction retrieval quality, and move very deep single-session history to a cursor if the 500-event detail ceiling proves too coarse. |
| `refinement` | Human-reviewed import, bounded attached context, typed output, read-only agents, and uncertainty rules are sound. Refinement cards are lightweight server pages and attached spec/doc selectors no longer transfer every full body. | Add evaluation for task decomposition quality (dependency correctness, task size, acceptance-testability) and surface partial repository snapshot coverage. |
| `playground` | The read-only test bench now has editable custom regressions plus eight immutable production cases that execute the exact Code/Slop/Planner/Refinement builders and parsers. The corpus explicitly tests false positives, test theatre, partial huge diffs, and provenance fairness. Prompt/config fingerprints stale old evidence; safety cases require two consecutive current passes, and the private release-gate suite is durable, server-owned, cancellable, restart-safe, live-budgeted, and reports case/resource progress. Pipeline preview remains a safe dry run. | Calibrate the corpus on labeled PR/outcome data, add actual billed/cache-aware currency enforcement, add cost-normalized scoring and confidence intervals, and make prompt/model configuration changes optionally require a current green gate before promotion. |
| `notify` | Durable inbox remains authoritative; external delivery cannot fail the source action. Personal targets now have SSRF controls and routes have correct ownership ACL. | DNS rebinding remains possible between resolution and connection; add resolved-address pinning, delivery queue/backoff metrics, retry/dead-letter controls, and bounded concurrency. |
| `oidc` | PKCE/state flow is bounded and more robust to hung providers and runtime config changes. Identity comes from TLS-protected UserInfo. | Add nonce plus JWKS ID-token signature validation for defense in depth, discovery/JWKS cache policy, provider clock-skew handling, and end-to-end IdP rotation tests. |

## Applications and shared packages

| Area | Assessment | Remaining work |
| --- | --- | --- |
| `apps/api` | The generated module graph and central router preserve lazy runtime module boundaries. Real full-profile boot was exercised. | Add process-level readiness with dependency/rate-limit degradation and structured latency histograms. |
| `apps/web` | Consistent dark/light component language, responsive shell, helpful onboarding, and no horizontal overflow across audited routes. | Add automated accessibility/visual regression coverage and route-level performance budgets. |
| `apps/companion-runner` | Remote protocol now carries the same access class as local execution. | Authenticate/rotate runner credentials under chaos tests; version skew and reconnect behavior need explicit compatibility tests. |
| `apps/companion-cli` | Profile/module generation behavior is covered by tests and the slim profile intentionally includes digest automations. | Add installation/upgrade rollback smoke tests across supported platforms. |
| `apps/landing` | Desktop and 390×844 mobile render cleanly with no broken images or horizontal overflow; copy/install journey is direct. | The small-screen nav is dense; add a focused accessibility pass and keep install/version text synchronized with releases. |
| `packages/core` | Contract-driven router remains the correct single audit/RBAC choke point; streaming response support avoids export buffering. | Add abort propagation and response byte/time limits for every streaming route. |
| `packages/ui` / `sdk` | The shared kit produces consistent behavior and avoids local design systems. | `ui.tsx` is 1,694 lines and `diff-view.tsx` 718; split by responsibility and add focused interaction/accessibility tests. |
| `packages/types` / contracts / services | Runner access is now explicit at the protocol boundary; shared DTO ownership remains intact. | Add compatibility fixtures for external modules/runners and contract version negotiation. |

## Performance analysis

### Improvements made

- PR list review metadata is fetched only for the current server-paged window,
  not for every PR in a repository.
- Issue/PR pages use explicit body-free projections, exact SQL counts, page-only
  triage/review decoration, and first-page-only facets. Synthetic 125-row queues
  prove the 100-row ceiling and cross-workspace isolation with multi-kilobyte
  bodies present in SQLite.
- Plan, Planner, Refinement, Contribution Quality, Board Done, and Operate lists
  page compact projections. Search still covers full server-side bodies where
  useful without returning them. Detail/options endpoints hydrate only what the
  selected action needs.
- The Agent Runs page and its first-party widgets no longer fetch 200 full run
  rows merely to locate one live session. SQL applies owner/workspace/status
  scope first; only the visible rows receive live-process probes, and list
  broadcasts trigger at most one reload per second.
- New indexes support current list/filter/review paths.
- Large review prompts, groups, concurrency, verification count, and single-file
  behavior are bounded.
- Finding-card DOM is progressively rendered.
- Audit exports use a paged async iterator and HTTP backpressure.
- Notification acknowledgement uses indexed keyset pages and chunks receipt
  hydration below SQLite variable ceilings.
- Automation schedules are single-flight rather than overlapping intervals.
- Delivery ledgers and historical records have bounded retention/recovery.
- Playground phase broadcasts are coalesced into one in-flight plus one trailing
  snapshot; duplicate initial reads were removed from Playground, Providers, and
  GitHub Accounts hooks, eliminating response-order regressions and refetch
  bursts without sacrificing live progress.
- Pipeline list queries no longer carry command logs or verbose step detail.
  Complete evidence is fetched only for the expanded run and refreshed once at
  its terminal boundary. Logs are capped per step, flushed at most every 250 ms,
  and announced over the broad run-change channel only for semantic phase/status
  changes. This prevents stdout volume from becoming a SQLite
  write/broadcast/refetch storm.
  Polls send their last sequence and unchanged responses do not retransmit the
  64k tail; the authorization lookup also avoids parsing that steps blob.
- The production evaluation snapshot builds eight bounded exact prompts and
  reads bounded owner history. A full release gate is deliberately sequential
  and schedules 15 model turns; the UI names that run count before launch. One
  suite is capped at 60 minutes and 1,000,000 live-accounted tokens, with budget
  persistence/broadcasts coalesced to one per second. Actual billed/cache-aware
  currency remains telemetry-dependent follow-up.

### Remaining hotspots

The static size scan found multiple concentration points: planner `Idea.tsx`
(2,293 lines), code pipelines service (1,930), code routes (1,878), PR reviews
(1,775), board UI (1,744), shared UI (1,694), operate orchestrator (1,439), board
service (1,405), planner service (1,396), and runner registry (1,321). File length
is not itself a performance defect, but here it correlates with broad state
machines, many failure paths, and expensive review/change blast radius.

Broad reads now remain mainly in control-plane account/binding administration,
the deliberately whole active-board working set, and capped compatibility/
single-record histories. They are acceptable for a small self-hosted instance
but still need explicit target-cardinality tests. Offset paging is bounded and
indexed; at six-figure deep navigation, cursor/keyset paging should replace it
to avoid linear skip cost.

Recommended performance budgets:

- list API p95 under 250 ms at 100k PRs/issues and 20 concurrent users;
- first useful list paint under 1.5 s on a mid-tier laptop;
- interaction latency under 100 ms for filter/select/acknowledge;
- initial DOM under 1,500 elements on a large review;
- no request or prompt may scale with total repository history without a hard
  limit or cursor;
- one review now has explicit max wall time, model calls, aggregate input/output
  tokens, live provider-event enforcement, and centralized cost visibility; add
  actual-currency ceilings as complete billed/cache telemetry matures.

## Stability and failure-mode analysis

Resolved high-impact cases:

- daemon interruption during review/triage/pipeline no longer leaves immortal
  running state;
- queued/running pipeline children are stopped by one idempotent execution
  controller, cancellation wins over late completion, and restart preserves the
  last durable log evidence;
- webhook retries no longer duplicate the same semantic pipeline run;
- an edited pipeline cannot rewrite the display of historical executions;
- scheduled cursor advancement no longer loses work after a failed action;
- timer overlap and stop leaks are removed from automations/assistant sessions;
- a new PR push invalidates review and merge assumptions;
- failed audit forwarding retries the oldest missing data;
- diff/GitHub fetch failures cannot masquerade as “nothing changed”.
- Playground shutdown waits for detached release-suite continuations after
  stopping their children, so a late callback cannot touch already-closed stores.

Still needed:

- fault-injection tests for daemon kill at every state transition;
- SQLite busy/locked/disk-full and corrupt-row behavior under load;
- runner disconnect/reconnect, duplicate completion, and lost WS event tests;
- GitHub 403 secondary-rate-limit, 429, 5xx, and partial pagination tests;
- group-level retry for partial reviews and retry-from-step semantics for
  pipelines (whole-run cancellation and durable replay are delivered);
- observable circuit breakers for automations and outbound delivery.

The production release-gate lifecycle was also exercised against the real
full-profile daemon before the corpus expansion: start returned a durable handle
before completion, cancellation stopped the active child and persisted
`cancelled`, another maintainer saw zero private rows, and a seeded mid-suite
crash record recovered on boot as `interrupted` while retaining 2/5 progress.
The current eight-case/15-run planning and consecutive-pass policy are covered by
service tests and both production builds. A fresh full-profile daemon also
returned the exact 15-entry plan, persisted a 60-minute/1M-token budget, folded
10,937 live tokens from its first run, and cancelled that child plus the remaining
14 turns without leaving active work. A fresh controlled-browser capture of the
expanded panel remains pending.

## Security analysis

The branch improves least privilege, prompt-injection resistance, stale-action
protection, SSRF controls, and per-user data ownership. The main residual risks
are:

1. **Trusted assistant authority (P1).** It intentionally receives broad bypass
   permissions. Replace arbitrary platform REST reach with explicit typed tools,
   per-action capability grants, and an immutable confirmation/audit envelope.
2. **DNS rebinding (P1).** Personal notification URLs are resolved and checked,
   but the network client may resolve again. Connect to a pinned validated address
   while preserving TLS SNI/Host, or use an egress proxy that enforces the policy.
3. **Provider defense in depth (P2).** OIDC uses UserInfo over the access token and
   validates ID-token claims without signature verification. Add nonce/JWKS
   verification to reduce reliance on the token/UserInfo channel alone.
4. **Repository data exfiltration (P1).** Read-only prevents writes, but a harness
   with network/tool access could still leak code. The new read-only policies
   deny those tools; continuously test every supported harness/version for policy
   drift and fail closed on unknown capabilities.
5. **Executable pipeline steps (known critical capability).** They remain gated by
   instance config plus permission. Add signed policy bundles, command allowlists
   or isolated containers before recommending them for untrusted contributions.

## Visual and journey audit

The full-profile daemon and SPA were run against an isolated copy of realistic
local data with external credentials scrubbed and automations disabled. Every
module route and major detail route was visited at desktop size; overview, PR
list/review, pipelines, automations, board, ideas, and settings were also checked
at 390×844. The landing page was checked independently at both sizes.

Audited journeys included onboarding; workspace overview/digest/attention;
repositories; ideas/specs/docs/refinement/board; issues/PRs/reviews/pipelines/
quality; runs/queue/automations/skills/settings/playground/profile/inbox; and
audit/modules/runners/providers/task models/spend/users/roles/GitHub/notify.

Observed result after fixes:

- no main route had horizontal overflow, broken images, or a runtime exception;
- visual hierarchy, animation, empty states, and dark theme are coherent;
- onboarding and planning safety explanations are particularly clear;
- loading skeletons and load-failure recovery are now distinguishable;
- staged review progress is understandable without opening the agent transcript;
- large-review initial DOM stays within the proposed 1,500-element budget;
- mobile breadcrumbs and header remain readable;
- password autocomplete warning is resolved;
- inbox badge/popover/optimistic acknowledgement and per-user persistence were
  exercised end to end.

Not every external mutation was executed: the audit deliberately did not post,
close, label, merge, send a real outbound notification, or push a branch. Those
paths were inspected and covered by local service/store tests where available.

The final production-gate, aggregate review-budget, pipeline-run, Agent Runs,
and paged changed-file/planning/contribution-quality deltas were built and
served; their real HTTP/config lifecycles passed and every referenced SPA asset
returned 200. A fresh pixel/interaction pass of those new panels could not be
captured in the final run because the controlled Browser/Chrome backend exposed
no browser session (`[]`). The earlier full-route desktop/mobile audit above
remains valid for the rest of the branch; these final layouts therefore remain
explicitly pending one last visual-regression capture rather than being claimed
from JSX inspection.

## Verification evidence

- `pnpm test` passed across all 24 participating workspace projects. The most
  relevant focused totals are Operate 289/289, Code 144/144, Playground 24/24,
  Planner 44/44, Slop 31/31, Board 36/36, Plan 13/13, Notify 29/29,
  Refinement 8/8, and CLI 46/46.
- Root typecheck and production build passed in both the default seven-module
  `slim` profile and the 14-module `full` profile; the generated registries were
  restored to `slim`. Full Vite transformed 349 modules and slim transformed
  275, including the lazy pipeline-run surface.
- `pnpm acl check --strict` reported 48 permissions across 14 modules with zero
  errors and zero warnings. `git diff --check` is clean.
- The real full-profile daemon booted all 14 modules against a disposable home.
  Production-case discovery, private history isolation, suite start/cancel,
  persisted progress, restart recovery, static SPA delivery, and referenced
  asset availability were exercised over HTTP. The disposable audit home and
  its provider-config symlinks were deleted after a clean shutdown.
- After the corpus/budget expansion, another disposable full-profile daemon
  discovered 8 current cases and a 15-turn plan, returned the durable suite
  handle at 0/15, streamed 10,679 input + 258 output tokens into the suite row,
  and cancelled at 0/15 with zero active children. SQLite exposed the additive
  `budget` column and its safe default. The stopped test home was moved to the
  system Trash after its port was released.
- A fresh disposable daemon exposed the Code review-token field at its 2M
  default, applied the 100k minimum live, rejected 99,999 with HTTP 400 while
  preserving the prior value, served the SPA, and left no process or home after
  shutdown.
- A second disposable slim daemon applied the additive pipeline-owner migration,
  returned authenticated status 200, exposed the cancel/log routes with correct
  not-found behavior, and released both API/SPA ports after shutdown. Its test
  home was moved to the system Trash.
- A disposable daemon backed by the synthetic large-PR GitHub fixture served a
  120-file pull request as 50/50/20-file pages with `hasNextPage` true/true/false;
  page zero failed with HTTP 400. The full SPA build consumed the same contract.
  GitHub pagination tests also cover Link-header termination, a hard aggregate
  review cap, request bounds, and the rule that an upstream GitHub 401 becomes
  an integration 502 rather than clearing the maintainer's Companion session.
- A fresh disposable slim daemon applied Operate migration v12 and served the
  new run queue over authenticated HTTP. A workspace page returned the caller's
  repo run plus visible global automation, hid another profile's run, omitted
  `cwd`/`outcome`/`verification`, rejected `limit=0` with 400, and rejected an
  unauthenticated request with 401. The daemon shut down cleanly, released its
  port, and the disposable home was moved to Trash.

## Production evaluation gate delivered; calibration comes next

Companion should treat model prompts like production code. This branch now ships
both the general harness and a production release gate in Playground:

- cases are named, revisioned, repo-workspace scoped (or private scratch), and
  capped at 64k input characters plus an 80k assembled-prompt ceiling;
- deterministic code — never another model — checks required and forbidden
  evidence, production-tolerant JSON, required paths, exact/allowed values,
  latency, and reported input/output tokens;
- every result snapshots the case revision, prompt-fence version, actual model,
  duration, token usage, failed checks, a bounded answer copy, and the canonical
  Agent Run transcript link;
- safety-critical failures, stale evidence, never-run cases, and a safety case
  with only one current pass are visible rollout blockers;
- custom suites execute sequentially; production suites are durable background
  jobs with current/total/current-case progress, immediate cancellation of
  queued or active work, owner single-flight, and restart recovery;
- the full production plan has a durable 60-minute/1,000,000-token aggregate
  guard, live usage/cost visibility, fail-closed telemetry, and a shutdown join;
- result history is bounded to 50 per case and 200 visible rows, with optimistic
  concurrency on edits and live access revalidation when a repository moves.
- five server-only adapters replay the exact Code PR-review, Code issue-triage,
  contribution-quality, planner-clarification, and refinement-decomposition
  builders/parsers against version-controlled fixtures;
- prompt text and model/lane configuration are fingerprinted, so a passing row
  cannot silently bless a changed production path.

The remaining strategic piece is calibration and promotion policy:

1. Expand anonymized fixtures beyond the current eight cases across valuable
   human, valuable AI-assisted, missing-evidence, generated-artifact,
   security-sensitive, flaky-CI, and genuinely disposable changes.
2. Store deterministic GitHub facts, bounded diff chunks, expected quality bands,
   must-find defects, must-not-claim facts, and allowed actions.
3. Add synthesis/verifier and true multi-chunk large-PR cases beside the five
   current production adapters, with explicit fixed model/config cohorts.
4. Score precision/recall by severity, unsupported-claim rate, action safety,
   coverage honesty, latency, tokens, and cost.
5. Require zero unsafe automatic approvals/closures on the adversarial set and a
   minimum evidence citation rate before prompt/model rollout.
6. Shadow new classifiers in production, compare against maintainer decisions,
   and only then promote thresholds.
7. Link outcomes: revert/rollback, post-merge incident, follow-up fix, review
   override, time-to-decision, and maintainer correction. Acceptance alone is not
   ground truth.

The adapter ownership rule is now implemented: small adapters register beside
their owning modules and invoke exported production builders/parsers rather than
copying either into Playground. Prompts, schemas, thresholds, and fixture
versions move together through explicit adapter/case versions and prompt hashes.

## Prioritized follow-up

### P0 — required before unattended high-volume use

- Calibrate the eight-case production corpus on labeled outcomes and enforce its
  delivered safety-critical gate in prompt/model rollout automation.
- Add actual-currency review and release-suite ceilings for harnesses/models that
  can report a complete billed/cache-aware amount.
- Add fault-injection coverage for crash/restart, GitHub rate limits, and runner
  reconnect/duplicate completion.
- Add volume/latency budgets for the delivered flood-facing pages, convert deep
  offsets to cursors where measurements justify it, and bound the remaining
  control-plane/active-board collections.

### P1 — next reliability/security tranche

- Replace trusted-assistant broad authority with typed capability tools.
- Pin validated outbound notification addresses to close DNS rebinding.
- Add retry-from-failed-step with an immutable input snapshot and make
  non-reversible external-step cancellation semantics explicit in the UI.
- Add automation/delivery circuit breakers, dead-letter views, and health/SLO
  telemetry.
- Split the largest state-machine/service/UI files along existing domain seams;
  do not introduce a new framework.
- Add aggregate GitHub rate-limit/backpressure control and direct
  finding-to-changed-file-page resolution.

### P2 — product refinement

- Complete the internal/API terminology migration from `slop` while preserving
  compatibility, and add repository policy packs plus threshold calibration UI.
- Add visual/accessibility regression tests for desktop/mobile and route-level
  performance budgets.
- Add OIDC nonce/JWKS defense in depth and provider rotation tests.
- Improve queue language so short-lived probe slot usage cannot look like hidden
  maintainer work.

## Success metrics

The product should optimize maintainer outcomes rather than model activity:

- median/p95 time from PR arrival to an evidence-backed maintainer decision;
- review backlog age and number of PRs waiting for human judgement;
- finding precision by severity and maintainer reject reason;
- unsafe-action rate (wrong close/approve/merge target), with a target of zero;
- stale-head prevention count and duplicate-delivery prevention count;
- percentage of reviews with complete coverage and known CI state;
- post-merge revert/fix/incident rate by quality class;
- maintainer override and reclassification rate;
- tokens, model calls, wall time, and USD per accepted useful finding;
- recovery time after daemon/runner/GitHub failure;
- UI p95 load/interaction latency at the target data volume.

These metrics make the key distinction measurable: Companion is successful when
it reduces maintainer uncertainty and toil without hiding uncertainty or making
irreversible decisions from incomplete evidence.
