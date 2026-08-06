# Runners: executing agent work on other machines

A **runner** is a machine that executes agent work. Companion ships with the
built-in **local runner**, the machine the daemon runs on, and can attach any
number of **remote runners**: other machines running the `companion-runner`
agent, reached over the network with a bearer token.

A machine's settings answer three different questions, and the page is laid out
that way because conflating them is how a fleet becomes unpredictable:

- **Capability** is what the machine can do: which providers and models it
  advertises. Discovered by probing it, not chosen.
- **Policy** is what it is allowed to do: which work, and which of its providers
  and models agents may use.
- **Placement** is where it participates and how much: workspaces, repositories,
  roles, and its own concurrency ceiling.

## How work is placed

Each runner is either **shared** (eligible for any workspace) or **delegated**
(serves only the workspaces you assign it), and a repository can pin a preferred
runner. When a run starts, Companion places it on an eligible, online runner and
prepares its git worktree there, so the whole run (gateway, clone, worktree and
session history) lives on one machine.

### What a machine will take

Work is registered as a **task**, `<module>.<name>`: `board.worker`, `code.fix`,
`automations.digest`. Each machine carries a policy over those:

| Mode | Meaning |
|---|---|
| `deny` (default) | takes everything except what you list |
| `allow` | takes only what you list |

An entry is either a **module** (`code`) or a **task** (`code.fix`). The module
level is not shorthand for today's tasks: it stores the module id, so it keeps
covering whatever that module registers in future versions. That is the whole
reason both levels exist, and why a task list alone cannot express "this machine
does not do the board". Underneath a module you can still be specific, which is
how "implements but does not review" is configured.

Two more fences sit alongside it. **Repository clearance** (`all`, or only the
repositories you select) is for a machine cleared for particular code. **Roles**
limit who may place work there; empty means every role, and automated work is
not attributed to a person.

A refusal names the fence that rejected it, rather than the first one in the
chain, so "why did this not run here" has one answer.

### Work no machine accepts

Under an allow-list this stops being hypothetical, so it is a setting on the
operate module rather than a hidden rule.

| Setting | Behaviour |
|---|---|
| `policy` (default) | the daemon's own machine takes it only if its own policy accepts it |
| `local` | the daemon's machine always takes it |
| `refuse` | nothing takes it, and the run is refused visibly |

The default matters most on an allow-list instance: without it, work nobody
explicitly permitted would quietly land on the daemon's machine, which is exactly
where the policy meant to keep it out.

Placement is **provider-aware**. Each selected runtime advertises the providers
and models it can actually serve. Companion prefers a compatible runner and
never places work on a machine whose runtime reports no usable capability. An
unpinned run always delegates model selection to that runtime's own default.

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

## Runtime ownership

Agent runtimes are external tools, not package dependencies of the Companion
core. Install and authenticate them on the machine that will execute work.
Companion detects supported runtimes, reads their reported capabilities, and
keeps every run isolated from the operator's normal CLI sessions.
