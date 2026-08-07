# companion-runner

The machine-holder agent daemon. Run it on any box you want Companion agent
work to execute on; a companiond elsewhere registers it as a **remote runner**
and drives it over HTTP + WebSocket (the protocol lives in
`@moxxy/companion-types` → `runner-agent.ts`, protocol version
`RUNNER_AGENT_PROTOCOL`).

Two very different machines run this:

- **a server or container**, which has nothing installed and runs work through
  the runtime bundled into this package;
- **your own laptop**, which is worth attaching precisely because of what IS
  installed on it: a signed-in Claude Code, a signed-in Codex, a CodeRabbit CLI
  that is authenticated as you. A Companion running in the cloud cannot use any
  of those. Attached as a runner, it can.

Locally it does exactly what companiond does on its own machine: it reuses the
execution, checkout, and session-history layers under its **own** data root, so
a companiond on the same box is never touched:

- starts the runtime selected for a run,
- holds git clones and per-run worktrees, produces diffs, commits, pushes,
- runs integration CLIs against a checked-out pull request,
- serves live/offline session history,
- streams run events back over `WS /agent/events`.

## What this machine can run

On start (and on every health poll) the runner reports what it found on disk.
Companion offers exactly that list for the machine and nothing else; a runtime
that is not installed is never advertised.

| Runtime | Where it comes from |
| --- | --- |
| **Companion** | Bundled into this package; a subprocess, nothing to install. Needs a model (see below). |
| **Moxxy** | `@moxxy/cli` on PATH, with a provider configured in the runner's moxxy home. |
| **Claude Code** | `claude` on PATH and signed in on this machine. |
| **Codex** | `codex` on PATH and signed in on this machine. |

A runtime that is installed but cannot complete a turn (signed out, no
provider, too old) is reported as unavailable **with the reason**, so
Companion's Runners page tells you what to fix here rather than leaving you to
guess. `companion-runner doctor` prints the same answers.

Sign-ins are never sent anywhere. A run placed on this machine under Claude
Code runs as this machine's Claude Code user, and the transcript is served back
over the same event stream a local run uses.

## Integration CLIs (CodeRabbit and friends)

Companion asks each machine whether it has the executables its enabled
integration providers declare. When a code review needs one, it takes the pull
request checkout **on a machine that has it** and runs the CLI there, streaming
the tool's output back while it runs.

So a CodeRabbit review works when `cr` is authenticated on your laptop even
though the Companion driving it runs somewhere with no CodeRabbit at all. The
machine that has the tool is chosen in this order: a runner pinned to the
repository, then your own machines, then everything else, then the daemon's own
box. What each machine has is listed on its page in Companion → Runners.

Nothing here is CodeRabbit-specific: a provider declares `requires: ['cr', …]`
and Companion does the rest.

## Tokens

Companion authenticates with a bearer token. Tokens are stored **hashed** in
`<home>/tokens.json`; the secret is printed once, when it is issued.

```sh
companion-runner token new "cloud companion"   # issue one, printed once
companion-runner token list                    # ids, labels, last use
companion-runner token revoke rt-1a2b3c4d      # takes effect immediately
companion-runner token rotate                  # issue one, revoke every other
```

Several can be valid at once, which is what makes rotation free of downtime:
issue a new one, paste it into Companion, revoke the old one. A running runner
picks both changes up on the next request, with no restart, even mid-run.

`COMPANION_RUNNER_TOKEN` still works and is always valid; it is never written to
disk, which is the right shape for a container configured by environment. A
first boot with no token at all issues one and logs it.

## Reaching a laptop

A laptop sits behind NAT on a network nobody is going to port-forward. Rather
than fight that:

```sh
companion-runner --tunnel        # or COMPANION_RUNNER_TUNNEL=1
```

opens a tunnel over moxxy's proxy relay and prints a public **https** URL, kept
stable across restarts by a key in the runner home. Register that URL in
Companion.

The https part is not cosmetic. The daemon refuses to put a model API key, an
MCP server definition or a tool's environment on a plain-http wire, so a
tunnelled machine can be given work that a plain-http one is refused,
including runs whose model comes from Companion rather than from this box.

For a machine on the same network, `companion-runner open-firewall` opens the
port and `doctor` prints the `http://<ip>:<port>` URLs to register.

## The dashboard

```sh
companion-runner ui
```

runs the agent with a live terminal dashboard instead of a log stream: where
Companion reaches this machine, which tokens are active and when they were last
used, what runtimes were detected and why one is not ready, how many runs are
live, and the last few log lines. Keys: `n` issue a token, `x` revoke every
older token, `t` publish a public address, `r` re-detect runtimes, `q` quit.

`companion-runner` with no arguments is unchanged: logs on stdout, which is
what a service manager wants.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMPANION_RUNNER_TOKEN` | *(none)* | Bearer token companiond may present. Optional: the token store below is the usual path. |
| `COMPANION_RUNNER_HOME` | `~/.companion-runner` | Data root (moxxy home, repos, worktrees, scratch, sessions, tokens). |
| `COMPANION_RUNNER_HOST` | `0.0.0.0` | Bind host. |
| `COMPANION_RUNNER_PORT` | `8920` | Bind port. |
| `COMPANION_RUNNER_TUNNEL` | *(unset)* | `1` publishes a public https address at start. |
| `COMPANION_RUNNER_GITHUB_TOKEN` | *(unset)* | Optional machine-specific GitHub PAT. Normally unset: the controlling Companion sends its own configured GitHub credential with each clone/fetch/push, held in memory only for that one git invocation. Set this to force this machine's own credential instead (per-machine audit trail / revocation). |
| `COMPANION_RUNNER_MAX_RUNS` | `3` | Max concurrently live runs, across every runtime. |
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

The second only happens over **https**, either a real certificate or
`--tunnel`. An http runner must carry its own model or it refuses those runs
and says why. Configuring the machine's own credential is also the option that
keeps per-machine revocation and a per-machine audit trail, exactly like
`COMPANION_RUNNER_GITHUB_TOKEN`.

## Install & run

It publishes as a self-contained package — the target machine needs only
Node ≥ 20:

```sh
npm i -g @moxxy/companion-runner

# check the box: Node, git, moxxy CLI, the agent CLIs it found, providers,
# tokens, and the network (bind host, whether the port is free, the URLs to
# register in Companion):
companion-runner doctor
# …or install/repair what it can (installs the moxxy CLI, opens the agent port
# on the host firewall; sudo may prompt):
companion-runner setup

companion-runner token new "my companion"     # the credential to paste

companion-runner ui                            # foreground, with the dashboard
COMPANION_RUNNER_TUNNEL=1 companion-runner ui  # …and publicly reachable
companion-runner --background                  # …or detached, logs in <home>/runner.log
companion-runner status                        # is it running? (pid + log path)
companion-runner stop
```

`@moxxy/cli` is an optional peer dependency, needed only to run work through
the Moxxy runtime: `companion-runner setup` installs it globally if it's
missing. `companion-runner --help` lists every command.

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

In companiond, add a runner with this machine's endpoint (the tunnel URL, or
`<host>:8920`, where plain http is assumed unless you write `https://`) and a token.
companiond probes `GET /agent/health`, refuses protocol mismatches, and from
then on provisions clones/worktrees and drives runs here; all working-directory
paths are local to this machine and opaque to companiond. Git operations that
touch the network arrive with companiond's GitHub credential unless this machine
sets `COMPANION_RUNNER_GITHUB_TOKEN`.

A machine that has never been given a runtime selection runs whatever it
reported ready, so a freshly attached laptop is usable immediately; the choice
is on its page in Companion once you want to narrow it.

## Model providers

Model credentials belong to this machine, not to companiond. Configure or sign
in through the runtime on the runner machine. Companion automatically refreshes
the providers and models reported by each selected runtime and stores no copy
of provider secrets.
