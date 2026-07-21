# companion-runner

The machine-holder agent daemon. Run it on any box you want Companion agent
work to execute on; a companiond elsewhere registers it as a **remote runner**
and drives it over HTTP + WebSocket (the protocol lives in
`@companion/contract` → `runner-agent.ts`, protocol version
`RUNNER_AGENT_PROTOCOL`).

Locally it does exactly what companiond does on its own machine — it reuses
companiond's modules verbatim (GatewayPool, Checkouts, session history) via
relative imports — but under its **own** data root, so a companiond on the
same box is never touched:

- spawns `moxxy serve` + `moxxy mobile` per run (isolated moxxy home),
- holds git clones and per-run worktrees, produces diffs, commits, pushes,
- serves live/offline session history,
- streams run events back over `WS /agent/events`.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMPANION_RUNNER_TOKEN` | *(generated)* | Bearer token companiond must present. If unset, one is generated, written to `<home>/token`, and logged once. |
| `COMPANION_RUNNER_HOME` | `~/.companion-runner` | Data root (moxxy home, repos, worktrees, scratch, sessions). |
| `COMPANION_RUNNER_HOST` | `0.0.0.0` | Bind host. |
| `COMPANION_RUNNER_PORT` | `8920` | Bind port. |
| `COMPANION_RUNNER_GITHUB_TOKEN` | *(unset)* | Optional machine-specific GitHub PAT. Normally unset: the controlling Companion sends its own configured GitHub credential with each clone/fetch/push, held in memory only for that one git invocation. Set this to force this machine's own credential instead (per-machine audit trail / revocation). |
| `COMPANION_RUNNER_MAX_RUNS` | `3` | Max concurrently live gateway (run) processes. |

The box also needs the `moxxy` CLI on PATH (`npm i -g @moxxy/cli`). On first
boot the runner imports moxxy provider credentials from the local `~/.moxxy`
into its isolated moxxy home (same import companiond offers from Settings).

## Install & run

It publishes as a self-contained package — the target machine needs only
Node ≥ 20 and the `moxxy` CLI, **not** a Companion checkout:

```sh
npm i -g @moxxy/companion-runner

# check the box is ready — Node, git, moxxy CLI, providers, tokens, and the
# network: bind host (loopback vs all-interfaces), whether the port is free,
# and the reachable http://<ip>:<port> URL(s) to register in Companion:
companion-runner doctor
# …or install/repair what's missing automatically (installs the moxxy CLI,
# opens the agent port on the host firewall — sudo may prompt):
companion-runner setup

# start it in the foreground:
COMPANION_RUNNER_TOKEN=<secret> companion-runner
# …or detached, with logs in ~/.companion-runner/runner.log:
COMPANION_RUNNER_TOKEN=<secret> companion-runner --background
companion-runner status   # is it running? (pid + log path)
companion-runner stop     # stop a background runner
```

No GitHub credential is needed on the box — the controlling Companion sends
its own with each git operation. `companion-runner open-firewall` opens the
agent port on the host firewall (ufw/firewalld on Linux, the application
firewall on macOS, Windows Defender Firewall) if `setup` didn't already.

`@moxxy/cli` is an optional peer dependency: `companion-runner setup` installs
it globally if it's missing (it's a CLI the runner shells out to, not a library
it imports). `companion-runner --help` lists every command.

From a monorepo checkout instead: `pnpm --filter @moxxy/companion-runner dev`
(watch mode) or `build` then `start`.

## Updating

```sh
npm i -g @moxxy/companion-runner   # update the agent itself
companion-runner stop && companion-runner --background
```

Companion's Runners page shows when a machine is outdated: an agent protocol
mismatch needs the on-machine update above, while an outdated **moxxy CLI**
can be updated straight from the runner card ("Update moxxy") — Companion
calls `POST /agent/update-moxxy`, which runs `npm i -g @moxxy/cli@latest`
here. Runs already in flight keep their old binary; new runs pick up the
update.

## Register with companiond

In companiond, add a runner with this machine's endpoint (`<host>:8920` —
plain http is assumed unless you write `https://`) and the token. companiond
probes `GET /agent/health`, refuses protocol mismatches, and from then on
provisions clones/worktrees and drives runs here; all working-directory paths
are local to this machine and opaque to companiond. Git operations that touch
the network arrive with companiond's GitHub credential unless this machine
sets `COMPANION_RUNNER_GITHUB_TOKEN`.
