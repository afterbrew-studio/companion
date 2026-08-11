# Releases

Companion uses one deliberate release path:

```text
change on main → Version pull request → CI → npm trusted publishing → GitHub Release
```

The `Version` workflow examines each publishable package's workspace dependency
closure. A change that can enter a tarball proposes the appropriate semantic
version; documentation, tests, and CI-only changes do not. Merging that pull
request is the maintainer's release decision.

`Publish` runs only after the exact push to `main` has passed CI. Its plan is
derived from every non-private workspace manifest, so adding a public package
cannot silently leave it outside the release path. The workspace builds once,
then verifies that every bare import emitted by every public package is a real
dependency or peer. New versions publish in dependency-first order; a failure
stops before a dependent package is exposed. Each package is uploaded only when
its declared version does not already exist on npm, which makes partial-run
retries safe. Publishing uses npm trusted publishing and GitHub OIDC, so the
repository does not keep a long-lived npm token.

## Product versions

The public Companion product version is the version of `@moxxy/companion` in
`apps/companion-cli/package.json`. A successful publish creates:

- an immutable `vX.Y.Z` tag on the first mainline commit that introduced that
  version;
- a GitHub Release with generated notes grouped by pull-request labels;
- the exact package tarball downloaded back from npm;
- a repository SPDX 2.3 SBOM generated asynchronously from GitHub's dependency
  graph at release time;
- `SHA256SUMS` for every attached integrity asset;
- a `full`-profile container image pushed to `ghcr.io/moxxy-ai/companion`,
  tagged with the release version (and `latest` for stable releases), with an
  SPDX SBOM of that image attached to the release.

The release job also requires the npm package to expose a provenance
attestation and installs the downloaded tarball before asking its executable
for the expected version. A package uploaded outside the trusted-publishing
path, or an artifact that cannot run, is not promoted to a product release.

The runner and public module ABI packages are independently versioned on npm.
They appear in the generated change notes but do not create competing product
tags.

## Recovery

The workflow is idempotent. Re-run the failed `Publish` workflow, or dispatch it
manually on `main`. Existing npm versions are skipped, an existing correct
release is a no-op, and a tag pointing to an unexpected commit stops the job
instead of moving history.

Do not create or move product tags manually. If npm publishing succeeded but
the release step failed, fix the failing prerequisite and rerun the same
workflow. The release job first verifies that the exact CLI version is already
available from npm.

Repository prerequisites are:

- an npm trusted publisher for every package in the publish matrix, configured
  for organisation `moxxy-ai`, repository `companion`, workflow `publish.yml`,
  and the `npm publish` action;
- after that path is verified, npm publishing access set to require 2FA and
  disallow traditional write tokens;
- GitHub Actions allowed to request an OIDC token;
- a public repository whose URL exactly matches every public package manifest,
  which npm requires for automatic provenance;
- the dependency graph enabled; release creation fails when its required
  repository SBOM cannot be generated and validated;
- `contents: write` available to the release job's `GITHUB_TOKEN`.
