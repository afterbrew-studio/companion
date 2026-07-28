# Runners: executing agent work on other machines

A **runner** is a machine that executes agent work. Companion ships with the
built-in **local runner**, the machine the daemon runs on, and can attach any
number of **remote runners**: other machines running the `companion-runner`
agent, reached over the network with a bearer token.

## How work is placed

Each runner is either **shared** (eligible for any workspace) or **delegated**
(serves only the workspaces you assign it), and a repository can pin a preferred
runner. When a run starts, Companion places it on an eligible, online runner and
prepares its git worktree there, so the whole run (gateway, clone, worktree and
session history) lives on one machine.

Placement is **provider-aware**. Runners advertise the model providers configured
in their moxxy home, Companion prefers one that can serve the run's pinned or
default model, and never places work on a runner with no providers at all. If a
run still lands somewhere its model is unavailable, that turn quietly rides the
runner's own default model rather than failing.

The local execution path is unchanged by any of this; remote runners are
entirely additive. Manage them in the admin **Runners** module.

## Attaching one

The agent publishes as a standalone package, so a machine needs only Node and the
moxxy CLI, not a Companion checkout.

```sh
npm i -g @moxxy/companion-runner
companion-runner setup   # installs the moxxy CLI if missing, imports providers, opens the firewall

COMPANION_RUNNER_TOKEN=<shared-secret> companion-runner --background
```

Then register the endpoint and token under **Runners**.

No GitHub credential is needed on the box: Companion sends its own configured
token with each clone and push. Set `COMPANION_RUNNER_GITHUB_TOKEN` to override
with a machine-specific PAT.

`companion-runner doctor` reports what a box still needs; `status` and `stop`
manage a background runner. The full environment is in
[`apps/companion-runner/README.md`](../apps/companion-runner/README.md). In a
monorepo checkout: `pnpm --filter @moxxy/companion-runner dev`.

## The moxxy runtime

moxxy is an **external runtime**, not a package dependency of this repository.
Companion expects the `moxxy` CLI to be installed and drives it over the moxxy
gateway wire protocol.

Every agent run uses its own `moxxy serve` and gateway process pair under an
isolated `MOXXY_HOME` inside Companion's data directory (`~/.companion/moxxy-home`
by default, `/data/moxxy-home` in Docker). That keeps Companion's sessions
separate from your own moxxy desktop, TUI and CLI sessions.
