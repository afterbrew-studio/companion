# Open items

What is genuinely not built, as of 2026-07-29, after P0 to P9 of
[`game-plan.md`](game-plan.md) landed.

The list is short on purpose. **Every mechanism from the plan exists**: build
profiles, generated registries, instance-defined roles, the audit trail with
retention and export, the entitlement gate, the single-node lock, the GitHub
endpoint and outbound proxy seams, the secret store seam, the OIDC reference
module, the published SDK, out-of-tree modules on both the server and the
browser, GitHub App credentials, and the published ABI.

What follows needs content or a decision, not a new mechanism, with these
exceptions: §1, §7 and §8 are built and kept here for their remaining rough
edges, and §6 needs nothing until a module asks for it.

Verified against the tree rather than remembered: each entry says what exists and
what does not, so nobody has to re-derive it.

---

## 1. GitHub App credentials `[BUILT]`

Was the one item that ended conversations. An account now connects either way:
a personal access token, or a **GitHub App installation** (App ID, Installation
ID, private key), which is what an organisation banning PATs or requiring
SSO-authorised tokens can actually use. Same registry, same purposes, same
per-repo resolution; only how the credential is obtained differs.

The shape worth knowing, because it is not the obvious one: `tokenFor` and
`clientFor` are **synchronous** and handed around as factories by a dozen call
sites, and `GitHubClient.headers()` is synchronous in every method. Making the
credential async to refresh something that changes once an hour would have
rippled through all of it. Instead the installation token is cached in the
account row with its expiry, a background job re-mints on a 25-minute margin
against a 10-minute interval (so one failed run still leaves a valid token and
another attempt), and `postActivate` refreshes at boot for the daemon that was
down longer than an hour.

The rough edge this section used to carry is **closed**: an installation that
stops refreshing now records health on the account row, shows a red chip with the
reason on the accounts page, and raises an inbox entry on the transition. See §9.

## 2. Publishing the module ABI `[BUILT]`

The six packages an out-of-tree module resolves types through are published:
`@moxxy/companion-sdk`, `-contracts`, `-core`, `-services`, `-types`, `-ui`.

**What made this hard, recorded because it is not obvious.** The first attempt
bundled the private framework declarations into the SDK with
`dts-bundle-generator`. The output was self-contained and **silently wrong**:
`@moxxy/companion-core` depends on the open registries, so inlining core inlined
`PermissionRegistry` with it, and a module augmenting `@moxxy/companion-contracts`
augmented one interface while `route({ access: ... })` read another. Measured by
packing both tarballs into a clean npm project: `Permission` resolved to `never`
and `access: 'hello:read'` was rejected. Marking contracts external does not
help, including as a real directory rather than a workspace link, because the
inlining is transitive.

Splitting the registries into a leaf package fails the same way, for the same
reason. So the framework is published instead, and the curation P8 exists for is
enforced where it always actually was:

- `companion module verify` allows an exact set of import specifiers, so a module
  importing `@moxxy/companion-core` is rejected before it is installed.
- The ABI bridge bridges only the SDK's three server entries, so at runtime
  anything reaching past them fails to resolve rather than getting a second copy.

**One packaging trap worth keeping.** `npm pack` leaves `workspace:*` literal, so
an npm-packed tarball installs nowhere; `pnpm pack` rewrites it to the resolved
version. Trusted publishing is an npm CLI feature. The workflow therefore packs
with pnpm and uploads that tarball with npm.

Verified the way the earlier attempt was disproved: all six packed, installed
into a clean npm project with no workspace links, and an out-of-tree module with
both a server and a client slice typechecked against them alone. The
augmentation lands, so `Permission` narrows to the declared id and rejects
anything else.

## 3. A commercial module `[business decision, not code]`

**Today:** the entitlement gate works and is verified in six states (no licence
and no key, valid licence with no key in the build, no licence with a key,
expired, a licence granting a different feature, valid), plus degradation:
a lapsed licence disables the module at boot while its tables and config stay
intact and the instance stays administrable.

**Missing:** any module to put behind it, and the private repo that would hold
one. See `docs/modular-distribution.md` §7, which is deliberately still
`[LATER]`: it is a repo and licensing decision, not an implementation.

## 4. A Vault or KMS secret backend `[a module, and now only a module]`

**Today:** `kind: 'secret'` config routes through a `SecretStore`. The default
keeps it in SQLite, `provideSecrets` swaps the backend, and the kernel moves
existing values across and deletes the originals so a swap does not silently
un-configure every module or leave plaintext behind. Three invariants are
covered by tests that fail when the behaviour is removed.

**Missing:** an implementation of the interface. Two rules for whoever writes
one: the provider's own credentials stay in the default store (a Vault module
cannot keep its Vault token in Vault), and an external store is not inside the
config transaction.

## 5. SAML `[declined, with a reason]`

Not an omission. SAML needs XML signature verification, which is a dependency
and a far larger attack surface than OIDC, and every provider Companion targets
(Okta, Entra ID, Auth0, Google Workspace, Keycloak) speaks OIDC. `modules/oidc`
is the reference implementation.

Revisit only for a customer who genuinely has no OIDC option, and copy the OIDC
module's shape rather than reinventing the handshake.

## 6. Install lifecycle for modules that are not just JavaScript

`docs/modular-distribution.md` §14, still `[LATER]` and correctly so.

Install is one atomic kernel call today: validate config, run migrations,
register services, mount routes, activate. That holds because every module ships
JavaScript and nothing else. A module carrying a native binary, requiring `git`
on PATH, or needing to reach a licence server breaks all three assumptions and
would need a real requirement-check phase.

Nothing needs doing until such a module exists. The design is written down so
the first one does not get an ad-hoc answer.

---

## 7. Spend control `[BUILT]`

Monthly ceilings (instance-wide and per profile) refuse run creation before any
side effect, alert at a configurable threshold, and attribute the period's cost
to a person, a task and a repository. See `ENTERPRISE.md` §4.

Two limits are deliberate and documented rather than fixed: the check is
"already at the ceiling" rather than "would this run cross it", because a run's
cost is unknowable before it executes; and a model with no list price
contributes zero, with its tokens reported separately instead of guessed at.

Still open: **no ceiling below a calendar month.** A single runaway night inside
a healthy monthly budget is caught only by the per-run output-token cap. A daily
ceiling is the same mechanism with a different `since`, worth adding when
someone hits it.

## 8. Outbound notifications `[BUILT]`

`module-notify` forwards the inbox to Slack, Discord, ntfy or a signed webhook,
off a single `notification.raised` bus event that every `ctx.notify.emit`
raises. No new dependency: all four destinations are one HTTP POST.

Per-recipient routing is **built**: notifications carry an optional recipient,
channels carry an optional owner, and delivery matches them 1:1 so a personal
destination never becomes a firehose. `notify:self` lets anyone wire up their own.

Still open: **delivery is not durable.** A destination down through both attempts
loses that notification (it stays in the inbox, and the failure is in the delivery
log, but nothing replays it). That needs a queue, and is not worth one until an
instance asks.

## 9. Operator health signals `[BUILT]`

The failures that only ever reached a log line now raise inbox entries, which the
outbound channels then deliver: a GitHub App installation that stopped refreshing
(the rough edge §1 has carried since it landed), a runner going offline and coming
back, and a queue that has stopped draining. Each fires on the state TRANSITION,
and credential health is persisted on the account row so a restart does not
re-announce the same outage.

**Deliberately not built: a licence-expiry sensor.** `ModuleContext` exposes no
licence state, an OSS build carries no issuer key so it can never hold a licence,
and expiry already degrades loudly at boot. It would be kernel surface for a
signal that cannot fire in this build.

Still open: nothing watches **disk** on the daemon's own volume. Clones,
worktrees and scratch have retention sweeps, so the failure is slow, but a full
`/data` is a real outage with no warning today.

## 10. Agent action policy `[BUILT]`

`agentGitWrite`, `protectedBranches` and `maxRunOutputTokens` are module config
rather than constants, enforced at the credential seam and audited on refusal.
See `ENTERPRISE.md` §4.

`agentGitHubWrite` closes the axis that was open here: comments, labels, reviews
and merges are gated at `GitHubClient`'s single write path, with `attended`
allowing them only while a person is asking. Attendance reuses the request-scoped
invoker rather than inventing a second notion of it.

Still open, and small: **a refusal under `attended` is retried on every sweep.**
The auto-merge sweep will find the same eligible PR each tick and be refused each
time, logging a warning. That is the same shape as any persistent failure the
sweep already tolerates (a merge conflict does likewise), so it is noise rather
than a fault, but an instance running `attended` permanently will see it.

## 11. Repository presets `[BUILT]`

Connecting a repo now offers a starting configuration (open-source project,
internal service, watch only) that sets the automation switches and creates a
pull-request pipeline. Presets are data, and a step whose module is disabled is
dropped and reported rather than left to error on every run.

Still open: presets are offered **only from the Automations page**, because the
switches are meaningless without that module and claiming the automation owner is
part of turning them on. Someone who adds a repo and never opens Automations
still sees nothing suggested. Offering it in the add-repo flow is the obvious next
increment.

## Carried work

Not gaps in a mechanism, which is why they sit below the line. Each one is
started, decided or blocked on something nameable, and each is the kind of thing
that gets forgotten precisely because none of it stops a release.

**Installing a module by name.** `[BUILT]` `companion module add <spec>` fetches
an out-of-tree module, checks it against the ABI while it is still staged, and
writes `$COMPANION_HOME/modules/.provenance.json` recording the spec as typed,
the resolved name and version, the integrity hash and the registry. npm resolves
the spec, so private registries and their credentials work without Companion
knowing anything about them. It installs no dependencies, because `verify`
already requires entry chunks to import the ABI and nothing else.

What remains is the seam either side of it: the daemon scans `modules/` once at
boot, so adding files still needs a restart before `module install <id>` can see
them, and nothing reads the provenance ledger back out into the UI.

**Runner workforce policy.** `[BUILT]` `blockedTasks` became a policy with an
`allow` mode, module-level entries that keep covering what a module registers
later, repository clearance and a role fence. The local machine's last-resort
role is now a setting (`unplacedWork`), defaulting to "only if its own policy
accepts it", because under an allow-list the old behaviour quietly landed
unpermitted work on the daemon's own machine. See [`runners.md`](runners.md).

Left undone there: switching modes drops policy entries whose module is not in
this build (their effective answer is unchanged either way), and `totalCapacity`
ignores repository clearance, documented as an over-approximation so the queue
keeps pumping at full width.

**Adding a moxxy provider from the UI.** In flight. Provisioning one means
reaching the runner's shell today. The moxxy side is `moxxy provision --spec=-`,
taking `{ provider, model?, key?, basics? }` as JSON on stdin. Write the flag
exactly that way: `--spec -` with a space silently falls through to the flag
path and prints usage, because moxxy's parser reads the bare `-` as a flag and
its `stringFlag` then sees a boolean rather than the string it wants.

The decision that shapes it: the credential passes through to moxxy on the
target machine and never persists in Companion. Not the database, not a log, not
a response, and never argv, which is what the stdin form is for. Providers that
sign in through OAuth (`moxxy login <provider>`) are interactive and are not
covered by this.

---

## 12. Pre-review verification `[BUILT]`

A repository carries a `verifyCommand`; when a fix/implement run enters review, it
runs in that run's worktree and the result lands above the diff. The point is to
spend a machine instead of a person: previously the only feedback loop was
push, open a PR, let CI fail, then let the board retry, and every turn of that
cost a PR round-trip, a CI run and a reviewer's attention.

Three states, not two. `unavailable` is distinct from `failed`: no command
configured, or a runner agent predating `/agent/verify`. "We did not check" and
"it does not build" must never render alike, because only one is about the code.
Added without a protocol bump, per the convention in `runner-agent.ts`, so an
older agent answers 404 and degrades rather than being marked outdated and taken
out of placement.

The board now retries on it, closing the loop: a failed verification goes through
the same `attemptFail` path as failed CI, so the cheap signal is what drives the
retry and the expensive one is only reached by work that passed. The gate returns
'wait' while verification is running, because it starts after the run enters review
and acting on the first event would open the PR before the answer arrived; a
verification stranded by a restart is demoted to unavailable at boot so nothing can
wait forever.

The previous failure is also fed into the next attempt's prompt. Without that a
retry was a re-roll: the agent repeated the attempt knowing nothing about what it
had broken.

Still open, and small: **a failed verification does not block a human approving
anyway.** That is deliberate for now (the reviewer can see the failure and may have
a reason), but there is no per-repository "refuse to open a PR on a failed
verification" switch for a team that wants one.

## 13. Worktree release on completion `[BUILT]`

A board task reaching `done` gives its worktree back immediately instead of
waiting out `worktreeRetentionDays`. Retention remains the backstop for everything
nobody announced; this is for the case where the work is provably over, which
matters because a worktree with a populated `node_modules` is large and a busy
board would otherwise hold days of them.

Both `done` paths clear `runId`, so the link is captured BEFORE the update. Operate
refuses on a run that is still active or in review, reusing the same protected set
storage cleanup uses, so "still in use" has one definition rather than two.

## Parked with a written design

**A forge abstraction (GitLab, Gitea, Forgejo).** Not built and deliberately not
started, but surveyed: [`specs/forge-abstraction.md`](../specs/forge-abstraction.md)
records what is actually coupled (136 files mention GitHub, and the expensive part
is not the client but the six GitHub concepts that leaked into DTOs, stores and
route paths), the order to unpick it in, and two cheaper alternatives.

The single line worth carrying: `owner/name` is the primary key in seven tables and
two route segments, and GitLab's nested groups make it invalid. That is what turns
a port into a migration, and it is why this is parked until there is a real
second-forge user to verify against.

## Not on this list, and why

- **Multi-node / active-active.** Decided against, not deferred.
  `ENTERPRISE.md` §2 and `docs/modular-distribution.md` §11: the binding
  constraint is the local filesystem (clones, worktrees, moxxy home), not the
  database, so Postgres would be necessary and nowhere near sufficient.
  Execution already scales through `companion-runner`. `InstanceLock` enforces
  the decision by refusing a second daemon on the same home.
- **An `edition` manifest field.** Build profiles say which modules ship and
  `entitlement` says which are licensed. A third axis would be a second way to
  say the same thing.
- **Backup and restore tooling.** `[BUILT]` `companion backup` / `companion
  restore`. Previously dismissed here as "worth a script only if the procedure
  grows", which was wrong for a reason worth recording: the documented procedure
  was a `cp` of the database plus its `-wal`, and that is not a consistent
  snapshot of a WAL database. `VACUUM INTO` is, and it works while the daemon
  serves. The two are now verified (`integrity_check` on the artifact, before a
  restore touches anything) and a restore keeps the replaced database aside.

  Still open: the backup covers the DATABASE only. Git clones are re-clonable and
  excluded on purpose, but the moxxy home holding provider credentials is a
  separate volume with no tooling, and losing it means reconfiguring every
  provider. The command says so on every run rather than leaving it to be
  discovered after a restore.
