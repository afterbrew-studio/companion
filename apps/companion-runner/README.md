# companion-runner

The machine-holder agent daemon. Run it on any box you want Companion agent
work to execute on; a companiond elsewhere registers it as a **remote runner**
and drives it over HTTP + WebSocket (the protocol lives in
`@companion/contract` → `runner-agent.ts`, protocol version
`RUNNER_AGENT_PROTOCOL`).

Locally it does exactly what companiond does on its own machine — it reuses
the execution, checkout, and session-history layers under its **own** data
root, so a companiond on the same box is never touched:

- starts the runtime selected for a run (the current remote-runner release
  ships the Moxxy adapter),
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
| `COMPANION_RUNNER_PROVIDER_KIND` | *(unset)* | This machine's own model for the **built-in runtime**: `anthropic`, `openai`, `azure` or `openai-compatible`. Set it with `COMPANION_RUNNER_MODEL` to give the box a model of its own. |
| `COMPANION_RUNNER_MODEL` | *(unset)* | Model id (on Azure, the deployment name). |
| `COMPANION_RUNNER_PROVIDER_URL` | *(unset)* | Endpoint. Required for `openai-compatible`; optional elsewhere to point at your own gateway. |
| `COMPANION_RUNNER_PROVIDER_KEY` | *(unset)* | API key for that endpoint. |
| `COMPANION_RUNNER_PROVIDER_API_VERSION` | *(unset)* | Azure only: the version the resource serves. |
| `COMPANION_RUNNER_PROVIDER_ID` | *(kind)* | Name this provider reports itself under. |

## The built-in runtime

Companion's own agent runtime ships inside this agent: it runs as a subprocess
of this bundle, so there is nothing to install and nothing to sign in to. That
is what makes a runner a plain container image.

It still needs a model, and there are two places one can come from:

- **this machine's own**, the `COMPANION_RUNNER_PROVIDER_*` variables above;
- **the controlling Companion's**, sent with the run.

The second only happens over **https**. The runner endpoint is plain http unless
you wrote `https://`, and the daemon will not put an API key on a plain-http
wire, so an http runner must carry its own model or it refuses those runs and
says why. Configuring the machine's own credential is also the option that keeps
per-machine revocation and a per-machine audit trail, exactly like
`COMPANION_RUNNER_GITHUB_TOKEN`.

Runtime credentials remain on this machine. The runner detects capabilities
from the runtime itself and reports them to Companion automatically.

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

Companion's Runners page shows when the runner agent protocol is outdated.
Update the agent on this machine with the commands above. Runtime installation
and upgrades remain owned by the machine rather than being mutated remotely by
the control plane.

## Register with companiond

In companiond, add a runner with this machine's endpoint (`<host>:8920` —
plain http is assumed unless you write `https://`) and the token. companiond
probes `GET /agent/health`, refuses protocol mismatches, and from then on
provisions clones/worktrees and drives runs here; all working-directory paths
are local to this machine and opaque to companiond. Git operations that touch
the network arrive with companiond's GitHub credential unless this machine
sets `COMPANION_RUNNER_GITHUB_TOKEN`.

## Model providers

Model credentials belong to this machine, not to companiond. Configure or sign
in through the runtime on the runner machine. Companion automatically refreshes
the providers and models reported by each selected runtime and stores no copy
of provider secrets.
