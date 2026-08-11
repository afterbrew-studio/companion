# Contributing to Companion

Companion is an early-preview, local-first control plane. Focused bug fixes,
documentation improvements, integrations, and well-scoped workflow proposals
are welcome. For a larger feature, open a feature request first so its product
boundary and module ownership can be agreed before implementation.

## Before opening an issue

- Use the bug form for reproducible defects and include the Companion version.
- Use the feature form to describe the problem and desired outcome.
- Report vulnerabilities only through a
  [private security advisory](https://github.com/moxxy-ai/companion/security/advisories/new).
- Remove credentials, private source, repository URLs, and personal data from
  logs and screenshots.

## Local development

You need Node.js 24 or newer and pnpm 10 (Corepack may install the exact pnpm
version declared by the repository):

```sh
corepack enable
pnpm install
pnpm build
pnpm dev
```

Read [`AGENTS.md`](AGENTS.md) before changing code. It routes to the verified
skills in `.ai/skills/` and records Companion's load-bearing invariants. The
short version is:

- shared HTTP and WebSocket types belong in the owning module's contract slice,
  augmenting the registries in `@moxxy/companion-contracts`;
- route metadata owns RBAC enforcement;
- GitHub remains authoritative for issues and pull requests;
- state mutations broadcast one matching change event;
- database migrations are additive and idempotent;
- relative ESM imports include `.js`, and secrets never reach the client.

Feature work should follow the module conventions in
[`modules/README.md`](modules/README.md). Avoid adding a dependency when the
platform or the existing UI kit already supplies the primitive.

## Verification

Run the checks relevant to the change, with the full gate before a pull
request:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm acl check
```

Types are not enough for behaviour or UI work. Start `pnpm dev`, drive the real
flow, and record what you observed in the pull request. Include screenshots for
visible changes and verify both the empty and populated state when applicable.

## Commits and pull requests

- Keep a pull request focused and explain why the change belongs in its chosen
  layer or module.
- Use conventional, imperative commit subjects such as `fix: stop duplicate
  review delivery`.
- Do not add AI attribution or `Co-Authored-By` trailers. The person submitting
  and reviewing the change owns it.
- Do not mix generated artifacts or unrelated formatting into the patch.
- Update user documentation when observable behaviour changes.

## Developer Certificate of Origin

Contributions are accepted under the
[Developer Certificate of Origin](https://developercertificate.org/). Sign off
every commit to certify that you wrote the change, or otherwise have the right
to submit it under the project license:

```sh
git commit -s
```

This appends a `Signed-off-by: Your Name <you@example.com>` trailer from your
git identity, which must be your real information. If a commit on your branch
is missing the trailer, `git commit --amend -s` or `git rebase --signoff` adds
it before you push.

Maintainers merge a version pull request to publish. The Publish workflow waits
for CI, uploads new package versions through npm trusted publishing, then creates
the immutable `vX.Y.Z` GitHub Release. Do not create or move release tags by
hand.
