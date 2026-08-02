# module-playground — design notes

## What shipped (first cut)

- **Agent Lab** (`#/playground`): one-shot test runs through
  `operate.orchestrator.runOneShot` — always prompt-fenced read-only
  (`buildPlaygroundPrompt`), cwd = the repo's Companion-owned clone or a scratch
  dir, bounded timeout, result rendered as markdown with a transcript link.
  Skill dry-runs are the same endpoint with the skill's content inlined into the
  prompt (deterministic load — no reliance on moxxy discovery order).
- **Pipeline Lab** (`#/playground/pipelines`): *evaluation only*. It calls
  `code.pipelines.resolveSteps` (made public for exactly this) so the preview
  shows the very snapshot `start()` would execute — refs resolved, overrides
  applied, unresolvable refs flagged with the engine's conservative pre-halt.
  Zero side effects: no run row, no GitHub call, no broadcast.
- **Evaluations** (`#/playground/evaluations`): named, revisioned regression
  cases with deterministic expectations (required/forbidden evidence, tolerant
  production-style JSON extraction, JSON paths/allowed values, latency and
  token ceilings). Every replay snapshots the case revision and server prompt
  version, links the canonical operate transcript, and stores only a bounded
  64k answer copy. Repo cases are shared through live workspace access; scratch
  cases stay private to their author. Safety-critical failures are explicit
  rollout blockers. Custom suites run sequentially with visible progress.
- **Production rollout gate** (the first section of Evaluations): immutable,
  version-controlled fixtures execute the exact prompt builder and parser
  registered by Code PR review, Code issue triage, Slop contribution quality,
  Planner clarification, and Refinement decomposition. Results snapshot the
  adapter version, exact prompt fingerprint, current model/lane configuration,
  actual runtime, deterministic checks, usage, and bounded parser/output copies.
  Any prompt/parser/fixture/config change makes old evidence stale. Each
  safety-critical case needs two consecutive current passes, so one stochastic
  success cannot make the rollout gate green.
- Production suites are **durable server-owned background jobs**: POST returns
  a handle immediately, progress and the current case persist across navigation,
  one owner can run only one suite, cancellation terminalizes before queued/live
  work is stopped, and boot recovery turns abandoned work into `interrupted`.
  Histories are owner-private and bounded. The current eight-case corpus expands
  to a 15-turn execution plan; one suite has a live 1,000,000-token and 60-minute
  aggregate guard. Provider events are folded monotonically, missing telemetry
  fails closed, budget refreshes are coalesced, and module shutdown joins the
  detached suite task before its stores close.
- Exploratory/custom **run endpoints remain synchronous** (the HTTP request
  awaits the one-shot), matching the existing generate-* endpoints and bounded
  by a 10-minute hard timeout. The production release gate is deliberately
  asynchronous because it contains several paid turns.

## Deferred: true pipeline step dry-run execution

Executing steps "for real but dry" needs per-kind mocking that the engine does
not have seams for yet:

- `checks-gate` / `ai-review` are already side-effect-free to *evaluate*
  (fetch CI summary, run the review agent without posting) — they could run
  as-is with `post`/apply suppressed.
- `label` / `comment` need a **recording GitHubClient** (capture the call,
  return success) so templates expand against the live PR without posting.
- `agent` steps already run read-only; a dry-run would execute them verbatim.

The clean shape: an `execute(..., { dryRun: boolean })` mode on the engine whose
step registry receives a no-op/recording client, producing a normal
`PipelineRunRecord` marked as a dry run (new column) so history stays separate.
That touches the engine's dependency wiring and the run store schema — too deep
for this cut and mid-flight with concurrent checks work; the preview ships now,
the engine seam is the named next increment.

## Deferred: async custom runs and broader calibration

Exploratory custom replays still await one bounded HTTP request. If they become
long-running, reuse the production suite's durable job shape rather than adding
a second queue protocol.

The initial production corpus defends eight high-impact decisions, including a
false-positive control, test theatre around an authorization bypass, and partial
huge-diff evidence that must stay undecided. It is not a statistically calibrated
benchmark. Next work is larger anonymized labeled corpora, synthesis/verifier
and true multi-chunk cases, precision/recall and unsupported-claim metrics,
billed/cache-aware cost cohorts, shadow evaluation against maintainer outcomes,
and an optional policy that blocks prompt/model promotion until every
safety-critical case is current and green.
