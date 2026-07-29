# module-slop — AI Slop Detection

Detects pull requests that were substantially machine-generated with low human
oversight, explains *why* with rule-attributed evidence, and proposes an action
— all review-then-apply: **nothing touches GitHub until a human applies a
verdict** (or a pipeline gates on the score, which is read-only).

## Architecture

Standard vertical module (`@companion/module-slop`), shaped after the two
closest precedents:

- **Detection** mirrors `code`'s `Triage`/`PrReviews`: one one-shot, read-only
  moxxy agent run (`orchestrator.runOneShot`, kind `analysis`) producing a
  strict-JSON verdict, extracted with `extractModelJson` + validated with zod.
  A parse miss or dead run is stored as `status: 'failed'` — never a fabricated
  verdict.
- **Rules** mirror `refinement`'s decomposition methods: built-ins live in code
  (`api/builtin-rules.ts`), custom rules are workspace-scoped SQLite rows.

Hard deps (`dependsOn`): `core`, `workspace`, `code` (PR sync cache + the
GitHub client registry), `operate` (orchestrator + checkouts).

### Data flow of one detection

```
POST /api/repos/:o/:n/prs/:num/slop-detect   (slop:act, 202, fire-and-forget)
  → SlopService.detect(repo, prNumber)
      PR record   ← code.prs (sync cache — GitHub-as-cache, no metadata fetch)
      rule set    ← enabled built-ins (workspace toggles) + enabled custom rows
      diff        ← GitHubClient.prDiff via the 'pipelines' purpose (the one
                    live read, same as ai-review/triage; clipped to 60k chars)
      verdict     ← ONE one-shot agent run in the repo clone, ALL rules in one
                    prompt (not one run per rule), strict JSON out
  → stored as pending/failed → broadcast 'slop.changed' → bus 'slop.verdict'
```

The agent runs in the repo checkout so rules can demand *verification* (does
that imported package exist in the lockfile?), not just vibes.

### The verdict

`SlopVerdict`: `aiLikelihood` 0–100 + `confidence` band, `summary`, `signals[]`
(each attributed to the `ruleId` that fired, with `observation` evidence and a
`weak|moderate|strong` strength), `recommendedAction`
(`none|label|comment|request_changes|close`), and a `draftComment` used by the
comment-shaped actions. Detections denormalize `prTitle` + the `ruleIds`
snapshot so history stays legible after cache churn or rule edits (same
philosophy as pipeline-run step snapshotting).

### Apply (the only writes to GitHub)

`SlopService.apply(id, { action?, accountId? })` — pending verdicts only; the
human may override the recommended action (e.g. downgrade `close` to
`comment`). Via `code`'s existing client surface (purpose `pipelines`):

| action | GitHub calls |
|---|---|
| `none` | nothing — marks the verdict acknowledged |
| `label` | `addLabels` with the module-config `label` (default `ai-slop`) |
| `comment` | `comment` with the draft (or a generated fallback line) |
| `request_changes` | `createPrReview(REQUEST_CHANGES)`, 422 (own-author) falls back to a `COMMENT` review — same dance as `PrReviews.apply` |
| `close` | `comment` then `closePr` — a silent close is hostile |

## The rule model (the extensibility core)

A rule = a named record whose `instructions` are fed **verbatim** into the
detection prompt — skills-like: prose heuristics, not code.

- **Built-ins** (5, in `api/builtin-rules.ts`, ids `builtin-*`): style tells,
  structural tells, provenance/metadata tells, diff-vs-description mismatch,
  hallucinated APIs/dependencies. One per signal family, so agreement across
  families outweighs one family firing repeatedly (the prompt says so).
- **Custom rules** (`sr-*` rows in `slop_rules`, workspace-scoped): full CRUD
  behind `slop:manage`.
- **Per-workspace toggles**: custom rules carry an `enabled` column; built-ins
  are toggled via `slop_builtin_toggles` override rows (absence = enabled).
- Detection concatenates every **enabled** rule into ONE agent run. Signals
  cite rule ids; ids are resolved to names at parse time from the run's own
  rule set (an id the model invents survives verbatim rather than vanishing).

Tables (v1 migration, with `down()`): `slop_detections` (90-day retention sweep
of settled rows on insert), `slop_rules`, `slop_builtin_toggles`.

## RBAC

`slop:read` (view detections/rules) / `slop:act` (run detection, apply,
dismiss) / `slop:manage` (rules CRUD + toggles), threaded manifest → acl
(admin `*`, maintainer all, business read) → contract `PermissionRegistry` →
route `access` → nav/route `permission` → slot `permission`. Workspace
visibility uses the house convention: unreachable workspace/repo/rule/detection
reads as 404, scoping goes through `workspace.canAccessRepo` /
`requireAccessible` and code's published `v_repos` view (never a raw foreign
JOIN).

## Integration points

1. **Pipeline step `slop-check`** (PR pipelines): one union member
   (`SlopCheckStep`, config `{ threshold }`) in code's
   `contract/pipelines.ts` + one handler in the engine + the step-editor form —
   the documented "one union member + one handler" pattern. Because slop
   `dependsOn` code, code resolves the service **softly at run time** through a
   structural seam (`SlopGateService` in `code/src/api/pipelines.ts`, wired via
   a commented `tryGet` cast in `code/src/api/services.ts`); a disabled slop
   module surfaces as a step *error*, never a crash. The gate runs a fresh
   detection, so the failing step arrives with its evidence stored as a pending
   verdict on the Slop page.
2. **Dashboard widget** via the existing `dashboard.widgets` slot (exactly how
   operate contributes its token-burn chart): the "AI slop radar" lists pending
   verdicts scoring ≥ 50 and renders nothing when the radar is clear. Zero
   edits to code's Dashboard.
3. **PR view flag — deferred seam.** Code's PR page (`pr/PrView.tsx`) exposes
   no slot today. Intended shape: a `pr.rail` slot outlet in `PrView`'s rail,
   into which slop contributes a latest-verdict chip via `defineSlots` (data:
   `GET /api/repos/:o/:n/prs/:num/slop`, already shipped). Not done now — that
   file's directory is under concurrent edit; the module's own pages + the
   dashboard widget carry the surface meanwhile.
4. **Board awareness — deferred hook** (board is owned by another engineer
   right now; not touched). Two seams already shipped from this side:
   - `SlopService.latestForPr(repo, prNumber)` — board can soft-resolve
     `ctx.services.tryGet('slop')` and flag tasks whose PR scored high.
   - Bus event `'slop.verdict'` `{ repo, prNumber, aiLikelihood,
     recommendedAction }` emitted on every stored verdict — board can
     subscribe in its `onEnable` and mark the owning task live.
5. **Boot replay**: queued detections survive a daemon restart via operate's
   durable run queue + a `'slop-detect'` resumer registered in `jobs.ts`
   (same mechanism as triage/pr-review).

## Contributor provenance (`api/provenance.ts`)

The provenance rule used to judge from prose. It now judges from facts fetched
at detection time, before the row is written, so the stored snapshot and the
agent's context are the same evidence:

| Fact | Source |
|---|---|
| Author standing in this repo (`FIRST_TIME_CONTRIBUTOR`, `OWNER`, …) | `pull().author_association` |
| Account age, public repos, followers, bot-ness | `user(login)` |
| Commit subjects, linked logins, timestamps, trailer keys | `prCommits()` |
| AI attribution lines, DCO sign-off, distinct authors, authoring span | derived from the above |
| Agent branch prefix (`codex/`, `cursor/`, …) | the PR's head ref |

Three properties the code is built around, each covered by a test:

- **Absence is not evidence.** A missing `author_association` reads as
  `unknown`, never `none`; an unreadable commit list is not DCO-compliant; a
  total GitHub outage yields `null` and the prompt then tells the agent to
  report no provenance signal at all.
- **Bounded and tolerant.** At most three ETag-cached requests, run
  concurrently, each failure degrading only its own fields. Provenance is
  context for a judgement, never a precondition for making one.
- **Clean provenance pulls the score down.** The rule is told to say so when a
  long-standing owner or collaborator authored the change, rather than only ever
  reporting incriminating facts.

Snapshotted into `slop_detections.provenance` (migration v2, additive) for the
same reason `rule_ids` is: evidence that cannot be re-read after a force-push is
not evidence. The detection page renders it above the verdict.

Still not fetched: `/users/:login/events` for cross-repo activity. The four
facts above answer the "brand-new author, sweeping first PR" tell without it.

## Deliberately deferred

- **Auto-detect on PR open.** Composable today with zero new code: a PR
  pipeline `{ slop-check }` with `autoRunOnPrOpen` — so a dedicated webhook
  hook would duplicate the pipeline path. Revisit only if a no-pipeline
  default-on mode is wanted.
- **Auto-apply for high-confidence verdicts** (PrReviews.gate-style). Slop
  actions are reputationally sharper than posting a review; keeping a human on
  the apply is the point (companion-security: agents advisory by default).
- **AI-drafted custom rules** (refinement's `generateMethod` pattern) — obvious
  next increment, same one-shot + draft-for-review shape.
- **Per-repo rule scoping** — rules are per-workspace; a repo override layer is
  YAGNI until a real workspace needs it.
