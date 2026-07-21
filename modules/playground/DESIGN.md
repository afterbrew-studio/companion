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
- The **run endpoint is synchronous** (the HTTP request awaits the one-shot),
  matching the existing generate-* endpoints. Bounded by the request's
  `timeoutMs` ceiling (10 min hard max).

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

## Deferred: async playground runs

`runOneShot` yields the run id only on completion, so the endpoint cannot
return a handle early without new infrastructure (parked results keyed by queue
entry, or reading the outcome off the run row). If long playground runs become
common, switch to: enqueue → return queue id → client follows `runs.changed`
and pulls the final message from the transcript endpoint.
