# The afterbrew fork

This repository is a fork of [`moxxy-ai/companion`](https://github.com/moxxy-ai/companion),
maintained for [`afterbrew-studio/rayf`](https://github.com/afterbrew-studio/rayf). The decision to
fork rather than deploy upstream is rayf's ADR-0055; the epic that must prove it safe before
activation is rayf's E-0004.

Upstream is MIT licensed and actively developed. This fork exists because rayf's accepted security
boundary is stricter than the upstream kernel, not because upstream is unmaintained.

## What `fork/ledger.json` is for

It records what this fork diverges **from**, machine-readably:

- `origin` and `upstream` as `owner/repo`
- `base.tag` and `base.sha` -- the released upstream revision this fork was taken at
- `patches` -- one entry per afterbrew change to the upstream kernel

`pnpm fork:provenance` verifies **four** things, and it is worth being precise about which, because
the rest of the ledger is documentation the verifier does not read:

| Field | Verified? |
|---|---|
| `origin`, `upstream` | yes - every fetch **and** push URL, host and path |
| `remote_hosts` | yes - the parsed authority must be one of these |
| `base.tag`, `base.sha` | yes - the tag resolves to the sha, and the sha is an ancestor of `HEAD` |
| `patches` | **no** - a kernel change with an empty `patches` list still passes |
| `release` | **no** - enforced by a guard in the workflows themselves, not by this script |

The `ci.yml` `provenance` job runs it, and runs `fork:provenance:check` beside it.

**Fix the tree, not the ledger.** The ledger is only edited by a deliberate rebase onto a new
upstream release, or by a patch entry landing with the patch. Editing it to make a red check green
destroys the only record of what this fork actually is.

## Verifying provenance

```sh
pnpm fork:provenance         # assert remotes, base tag and base sha agree
pnpm fork:provenance:check   # prove the check above can fail
```

The second command matters as much as the first. It clones this repository to a throwaway
directory, re-points a remote, moves the recorded base sha, removes the upstream remote, and asserts
the verifier rejects each one -- a check whose failing path has never run is an assumption.

## Fetching upstream

A clean clone has no `upstream` remote and no upstream tags. Both are needed before
`pnpm fork:provenance` can resolve the base tag:

```sh
git remote add upstream https://github.com/moxxy-ai/companion.git
git fetch --tags upstream
pnpm fork:provenance
```

## Taking an upstream update

Upstream changes arrive only through a deliberate, reviewed merge. There is no automatic update,
and none should be added: an unattended merge into a fork whose whole purpose is a stricter
security boundary is the failure this arrangement exists to prevent.

1. `git fetch --tags upstream`
2. Read the diff between `base.sha` and the candidate release tag. Every kernel patch in
   `patches[]` is a place upstream may have changed underneath a deliberate divergence, so check
   each one specifically rather than trusting the merge.
3. Merge the release tag, never `upstream/main` -- a moving branch is not a reviewable base.
4. Update `base.tag`, `base.sha`, `base.published` and `base.selected` in the ledger, in the same
   commit as the merge.
5. Re-run every gate. `pnpm fork:provenance` proves the ledger matches; it does not prove the merge
   is safe, and nothing here substitutes for the security gates.

## Patch entries

Each entry in `patches[]` names the upstream gap it closes, the negative test that proves it closed,
and whether it is being upstreamed. A patch with no negative test is not a safety control, and a
patch with no upstreaming disposition is a divergence nobody has decided to keep.

The list is empty today. rayf's P-0005 ends with the baseline proven and no kernel change landed;
P-0006 is what adds them.

## Release identity: this fork publishes nothing

`publish.yml` and `version.yml` are **disabled** here.

Upstream's Publish workflow releases the `@moxxy/*` npm scope. Its job guard checks the branch, the
triggering event and the CI conclusion - and never checks `github.repository`. On a fork that means
a green push to `main` reaches the publish step, and the only thing standing between it and npm is
upstream's own trusted-publisher configuration, which is a third party's control rather than one
this repository owns. Publishing fork code under upstream's package names would be a supply-chain
incident against an MIT project we depend on.

`version.yml` opens the version-bump pull requests that Publish waits for, so it is disabled for the
same reason: on a fork it produces noise and it is the mechanism that would eventually trip Publish.

**The guard is in the workflows, not just in the Actions API.** Both jobs carry
`if: github.repository == 'moxxy-ai/companion'`. An API-level disable is one UI click from being
undone and leaves nothing in the tree to review; a condition in the file survives a re-enable and
travels with any clone. Both are in force here.

Neither workflow is one of the gates P-0005 A2 must reproduce - the type, test, build, SDK, ACL,
dependency, CodeQL and container gates all live in `ci.yml`, which stays active.

That is **not** the same as saying nothing is lost. `version.yml` is the only caller of
`scripts/version.mjs`, and `publish.yml` is the only place the delivered tarball is packed and
installed. Neither operation happens anywhere in `ci.yml`, so on this fork a regression in release
planning or package composition would go undetected. That is an accepted gap, not an absent one: the
fork does not release, so neither regression can reach anyone from here.

If this fork ever needs to publish artifacts, it publishes under an afterbrew scope from a workflow
that names this repository explicitly. It does not re-enable upstream's.
