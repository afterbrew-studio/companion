<h1 align="center">companion-runner</h1>

<p align="center">
  <strong>Run Companion's agent work on a machine you choose.</strong><br>
  A container with nothing installed, or your own laptop with everything you are
  already signed in to.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@moxxy/companion-runner"><img alt="npm" src="https://img.shields.io/npm/v/%40moxxy%2Fcompanion-runner?color=0b7285&label=npm"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A524-3c9a5f">
  <a href="https://github.com/moxxy-ai/companion/blob/main/LICENSE"><img alt="licence" src="https://img.shields.io/badge/licence-MIT-495057"></a>
</p>

---

```sh
npm i -g @moxxy/companion-runner

companion-runner doctor         # what this machine can run, and what is missing
companion-runner token new      # the credential Companion will present
companion-runner ui             # start it, with a live dashboard
```

Register the printed URL and token under **Runners** in Companion. The machine
then advertises what it can actually run, takes placed work, holds its own
clones and worktrees, and streams every run back live.

A runner keeps its own data root (`~/.companion-runner` by default), so a
Companion daemon on the same box is never touched.

## Why attach your own machine

A Companion in the cloud can run agents. What it cannot do is be signed in as
you. Attaching a developer machine is how a team gets the other half:

| | On the daemon's own machine | On your machine, attached as a runner |
| --- | --- | --- |
| **Agent runtimes** | whatever the server has | your signed-in Claude Code and Codex |
| **Integration CLIs** | whatever the server has | your authenticated CodeRabbit CLI |
| **Model credentials** | the instance's | this machine's, or the instance's over https |
| **Git credentials** | the instance's | the instance's, or this machine's own PAT |

Nothing is uploaded to make that work. Sign-ins stay on the machine that holds
them; Companion places the work where the credential already is.

## What the machine advertises

On start, and on every health poll, the runner reports what it finds on disk.
Companion offers exactly that list and nothing else, so a runtime you have not
installed is never presented as an option.

| Runtime | Where it comes from | Models |
| --- | --- | --- |
| **Companion** (built-in) | bundled into this package; a subprocess, nothing to install | your key, or the instance's over https |
| [moxxy](https://github.com/moxxy-ai/moxxy) | `@moxxy/cli` on PATH, with a provider in the runner's moxxy home | the machine's own providers |
| [Claude Code](https://claude.com/claude-code) | `claude` on PATH and signed in here | its own sign-in |
| [Codex](https://developers.openai.com/codex) | `codex` on PATH and signed in here | its own sign-in |

A runtime that is installed but cannot complete a turn (signed out, no
provider, too old) is reported unavailable **with the reason**, so Companion's
Runners page tells you what to fix on this box instead of leaving you to guess.
`companion-runner doctor` prints the same answers.

A run placed here under Claude Code runs as this machine's Claude Code user,
and its transcript comes back over the same live stream a local run uses.

## Integration CLIs

Companion asks each machine whether it has the executables its enabled
integration providers declare. When a code review needs one, Companion takes
the pull-request checkout **on a machine that has it** and runs the CLI there,
streaming the tool's output back while it works.

So a [CodeRabbit](https://docs.coderabbit.ai/cli/reference) review runs against
your authenticated `cr` even though the Companion driving it has no CodeRabbit
at all. Machines are tried in this order:

1. a runner pinned to the repository,
2. the requesting user's own machines,
3. every other eligible machine,
4. the daemon's own, last.

What each machine was found to have is listed on its page under **Runners**.
None of this is CodeRabbit-specific: a provider declares
`requires: ['cr', 'coderabbit']` and Companion does the rest.

## Tokens

Companion authenticates with a bearer token. Tokens are stored **hashed** in
`<home>/tokens.json`, and the secret is printed once, when it is issued.

```sh
companion-runner token new "cloud companion"   # issue one, printed once
companion-runner token list                    # ids, labels, last use
companion-runner token revoke rt-1a2b3c4d      # effective immediately
companion-runner token rotate                  # issue one, revoke every other
```

Several may be valid at once, which is what makes rotation free of downtime:
issue a new one, paste it into Companion, revoke the old one. A running runner
picks up both changes on the next request, with no restart, even mid-run.

`COMPANION_RUNNER_TOKEN` still works and is always valid. It is never written to
disk, which is the right shape for a container configured by environment. A
first boot with no token at all issues one and logs it.

## Reaching a machine that is not on your network

A laptop sits behind NAT on a network nobody is going to port-forward. Rather
than fight that:

```sh
companion-runner --tunnel        # or COMPANION_RUNNER_TUNNEL=1
```

opens a tunnel over moxxy's proxy relay and prints a public **https** URL, kept
stable across restarts by a key in the runner home. Register that URL.

The https part is not cosmetic. Companion refuses to put a model API key, an
MCP server definition, or a tool's environment on a plain-http wire, so a
tunnelled machine can be given work a plain-http one is refused, including runs
whose model comes from Companion rather than from this box.

For a machine on the same network, `companion-runner open-firewall` opens the
port and `doctor` prints the `http://<ip>:<port>` URLs to register.

## The dashboard

```sh
companion-runner ui
```

Runs the agent with a live terminal dashboard instead of a log stream: where
Companion reaches this machine, which tokens are active and when they were last
used, what runtimes were detected and why one is not ready, how many runs are
live, and the last few log lines.

| Key | |
| --- | --- |
| `n` | issue a token |
| `x` | revoke every older token |
| `t` | publish a public address |
| `r` | re-detect runtimes |
| `q` | quit |

`companion-runner` with no arguments is unchanged: logs on stdout, which is
what a service manager wants.

## Commands

| | |
| --- | --- |
| `companion-runner` | start in the foreground |
| `companion-runner ui` | start with the dashboard |
| `companion-runner --background` | start detached; logs in `<home>/runner.log` |
| `companion-runner --tunnel` | also publish a public https address |
| `companion-runner status` | is one running, and its pid |
| `companion-runner stop` | stop a background runner |
| `companion-runner doctor` | check this machine is ready to attach |
| `companion-runner setup` | doctor, plus install and repair what it can |
| `companion-runner token` | issue, list, revoke, rotate credentials |
| `companion-runner open-firewall` | open the agent port on the host firewall |
| `companion-runner autostart` | start on boot and restart on crash |

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMPANION_RUNNER_TOKEN` | *(none)* | Bearer token Companion may present. Optional: the token store above is the usual path. |
| `COMPANION_RUNNER_HOME` | `~/.companion-runner` | Data root (moxxy home, repos, worktrees, scratch, sessions, tokens). |
| `COMPANION_RUNNER_HOST` | `0.0.0.0` | Bind host. |
| `COMPANION_RUNNER_PORT` | `8920` | Bind port. |
| `COMPANION_RUNNER_TUNNEL` | *(unset)* | `1` publishes a public https address at start. |
| `COMPANION_RUNNER_MAX_RUNS` | `3` | Concurrently live runs, across every runtime. |
| `COMPANION_RUNNER_GITHUB_TOKEN` | *(unset)* | Machine-specific GitHub PAT. Normally unset: Companion sends its own configured credential with each clone, fetch, and push, held in memory for that one git invocation. Set this to force this machine's credential instead, for a per-machine audit trail and revocation. |
| `COMPANION_RUNNER_PROVIDER_KIND` | *(unset)* | This machine's own model for the built-in runtime: `anthropic`, `openai`, `azure`, or `openai-compatible`. |
| `COMPANION_RUNNER_MODEL` | *(unset)* | Model id, or on Azure the deployment name. |
| `COMPANION_RUNNER_PROVIDER_URL` | *(unset)* | Endpoint. Required for `openai-compatible`, optional elsewhere to point at your own gateway. |
| `COMPANION_RUNNER_PROVIDER_KEY` | *(unset)* | API key for that endpoint. |
| `COMPANION_RUNNER_PROVIDER_API_VERSION` | *(unset)* | Azure only: the version the resource serves. |
| `COMPANION_RUNNER_PROVIDER_ID` | *(kind)* | Name this provider reports itself under. |

## The built-in runtime

Companion's own agent runtime ships inside this agent as a subprocess of the
bundle, so there is nothing to install and nothing to sign in to. That is what
makes a runner a plain container image:

```sh
docker build --target runner -t companion-runner .    # from the Companion tree
```

It still needs a model, and there are exactly two places one can come from:

- **this machine's own**, the `COMPANION_RUNNER_PROVIDER_*` variables above;
- **the controlling Companion's**, sent with the run, and only over https.

A machine with neither reports the runtime unavailable and names both fixes,
rather than accepting work it cannot finish. Configuring the machine's own
credential is also the option that keeps per-machine revocation and a
per-machine audit trail, exactly like `COMPANION_RUNNER_GITHUB_TOKEN`.

## Register with Companion

Add a runner under **Runners** with this machine's endpoint (the tunnel URL, or
`<host>:8920`, where plain http is assumed unless you write `https://`) and a
token. Companion probes `GET /agent/health`, refuses a protocol mismatch, and
from then on provisions clones and worktrees and drives runs here. Every
working-directory path is local to this machine and opaque to Companion.

A machine that has never been given a runtime selection runs whatever it
reported ready, so a freshly attached laptop is usable immediately. Narrowing
that, along with task policy, repository clearance, role fences, and the
concurrency ceiling, is done on its page.

## Updating

```sh
npm i -g @moxxy/companion-runner
companion-runner stop && companion-runner --background
```

The Runners page shows when a machine's agent protocol is outdated. Runtime
installation and upgrades stay owned by the machine rather than being mutated
remotely by the control plane.

## How it works

Companion drives this agent over HTTP and one WebSocket. The wire contract
lives in `@moxxy/companion-types` (`runner-agent.ts`), imported by both sides so
it cannot drift, and versioned by `RUNNER_AGENT_PROTOCOL`.

| | |
| --- | --- |
| `GET /agent/health` | runtimes, live runs, protocol |
| `POST /agent/runs/:id/*` | spawn, prompt, command, stop, history, session info |
| `POST /agent/git/*` | clone, fetch, worktrees, diff, commit, push |
| `POST /agent/tools/*`, `/agent/exec` | detect and run integration CLIs |
| `POST /agent/verify` | a repository's own verification command |
| `POST /agent/storage/cleanup` | retention, decided by Companion, executed here |
| `WS /agent/events` | run events, approvals, live command output |

Locally it reuses Companion's own execution, checkout, and session-history
layers, so a run behaves the same wherever it lands.

## Documentation

| | |
| --- | --- |
| [Runners](https://github.com/moxxy-ai/companion/blob/main/docs/runners.md) | multi-machine execution and placement policy |
| [The built-in harness](https://github.com/moxxy-ai/companion/blob/main/docs/builtin-harness.md) | the agent runtime Companion owns |
| [Model providers](https://github.com/moxxy-ai/companion/blob/main/docs/model-providers.md) | bring your own key, endpoint, and catalogue |
| [Configuration](https://github.com/moxxy-ai/companion/blob/main/docs/configuration.md) | environment, GitHub Enterprise, and proxies |
| [Companion](https://github.com/moxxy-ai/companion) | the control plane this agent serves |

From a monorepo checkout instead of npm:
`pnpm --filter @moxxy/companion-runner dev`, or `build` then `start`.

## Licence

MIT. See [`LICENSE`](https://github.com/moxxy-ai/companion/blob/main/LICENSE).
