# Spec: a forge abstraction (GitLab, Gitea, Forgejo)

**Status: parked, deliberately.** Nothing here is built. This exists so the first
attempt starts from a survey instead of from optimism, and so the decision to park
it is recoverable rather than just forgotten.

Written 2026-07-30, against the tree at that point. Re-measure before trusting the
numbers; the shape will outlive them.

---

## 1. Why it is worth doing, and why not yet

Companion's wedge is the maintainer drowning in low-oversight AI contributions.
A meaningful share of the projects feeling that most acutely are not on GitHub,
including some that left over exactly these questions. Supporting one more forge
roughly doubles the addressable set without adding a single feature.

It is parked because it is the most expensive item on the list and the only one
whose cost is mostly *breadth*: 54 files in `module-code` alone mention GitHub,
plus 16 in `operate` and 13 in `automations`. None of it is hard. All of it has to
be right at once, because a half-ported forge is worse than none: it produces a
product that appears to support GitLab and silently misbehaves on the paths nobody
exercised.

Do it when there is a concrete second-forge user to verify against. Doing it
speculatively means designing an interface against one implementation, which is
how you get an abstraction shaped exactly like GitHub with different words.

## 2. What is actually coupled

Measured, not guessed. Three layers, in increasing order of difficulty.

### Layer 1: the client. Easy, and misleading about the total.

`modules/code/src/api/github-client.ts` is one class over `fetch` with no octokit
dependency, ETag-cached GETs, ~25 methods. Replacing it with an interface plus two
implementations is a day's work and looks like the whole job. It is not.

### Layer 2: concepts that leaked into the contract. The real work.

These appear in DTOs, stores and UI, so changing them ripples:

| Concept | Where it lives | GitLab equivalent |
|---|---|---|
| `RepoPermission` ladder (`pull`/`triage`/`push`/`maintain`/`admin`) | contract, account resolution, every action gate | Access levels 10/20/30/40/50. Orderable, but not the same rungs: no `triage`. |
| `author_association` (`OWNER`/`MEMBER`/`FIRST_TIME_CONTRIBUTOR`…) | slop provenance, the newest feature | **No equivalent.** Needs deriving from member lookups plus prior-MR counts, i.e. extra requests and a different confidence. |
| `GhCheckRun` + `GhCombinedStatus` (two CI systems) | `pr-checks`, the checks-gate step, PR UI | One pipeline model with jobs. Simpler, and so does not fit a shape built to merge two. |
| `mergeable` / `reviewDecision` | PR sync cache, auto-merge sweep | `merge_status` plus approval rules. Different states, different staleness semantics. |
| `X-Hub-Signature-256` HMAC over raw bytes | `automations` webhook receiver | GitLab sends a plain shared-secret token header. **No HMAC at all**, so the verification code has no analogue and the security property differs. |
| `owner/name` as the primary key everywhere | every table, every route path | GitLab nests groups arbitrarily deep (`group/sub/project`), so `owner/name` is not a valid key and route paths break. |

The last row is the one that turns a port into a migration: `full_name` is the
primary key in `repos`, `issues`, `prs`, `triage_results`, `pr_reviews`,
`slop_detections`, `pipeline_runs` and the `v_repos` view, and it appears in route
paths as two segments (`/api/repos/:owner/:name/...`).

### Layer 3: what already generalises for free

Worth knowing so it is not re-litigated:

- **Credential resolution.** The multi-account registry with purposes, per-repo
  binding and access verification is forge-agnostic in shape. Only minting differs.
- **The git layer.** `Checkouts` speaks git over HTTPS with an ephemeral credential
  helper and a configurable host. Already generic.
- **GHES support proves the endpoint seam works.** `COMPANION_GITHUB_API_URL` and
  `COMPANION_GITHUB_HOST` already move the whole client. A *different* forge is
  the next step along a road that exists.
- **Agent execution, budgets, policy, runners, notify, audit.** Untouched by this.

## 3. The shape to aim for

**Do not start with the interface.** Start by making the domain stop speaking
GitHub, then the interface falls out.

1. **Introduce a repo identity type.** Replace bare `full_name: string` with an
   opaque `RepoKey` (an id the forge adapter parses) plus a display path. Do this
   as a mechanical, behaviour-preserving refactor with the GitHub adapter as the
   only implementation, and land it separately. This is the largest and least
   interesting step, and mixing it with anything else makes the diff unreviewable.
2. **Neutralise the leaked concepts** one at a time, each on its own: a
   `ContributorStanding` derived per forge rather than `author_association`
   passed through; one `CiSummary` instead of check-runs plus statuses; a
   `MergeReadiness` instead of `mergeable` plus `reviewDecision`.
3. **Then extract `ForgeClient`**, and only then. If the steps above are done, its
   methods are obvious and none of them mention a vendor.
4. **Webhook verification becomes a per-forge strategy**, not a shared helper.
   HMAC-over-raw-bytes and compare-a-token are different security properties and
   should not share a code path that makes them look interchangeable.

### Non-goals

- **Feature parity across forges.** A forge that cannot express something should
  make the feature *absent*, the way a disabled module is absent, not degraded and
  quietly wrong. `capabilities` on the adapter, checked in the UI.
- **Runtime multi-forge in one workspace.** Per instance, or at most per
  workspace. Repos from two forges in one pipeline is a second problem.
- **Preserving `owner/name` in URLs.** It will not survive nested groups. Accept
  the route change and version it.

## 4. How to know it worked

- A GitLab instance completes: connect account, add repo, sync issues and MRs,
  triage an issue, run a slop detection, open an MR from a fix run, receive a
  webhook.
- `grep -ril github modules/*/src` returns hits **only** inside the GitHub
  adapter and its tests. That single check is the honest definition of done, and
  it is why this is expensive: today that grep hits 136 files.
- Every existing GitHub test still passes untouched. If porting required editing
  GitHub tests, the abstraction changed behaviour and is wrong.

## 5. Cheaper alternatives, recorded so they are not rediscovered

- **Read-only mirror mode.** Sync from any forge over plain git, run analysis, post
  nothing back. Delivers slop detection and triage advice with none of layer 2. A
  real fraction of the value for a small fraction of the cost, and the honest
  first increment if the full port stays parked.
- **Webhook-only ingestion.** Accept a generic payload an operator maps themselves.
  Cheap, and pushes the cost onto every user forever, so it is a bad default and a
  reasonable escape hatch.
