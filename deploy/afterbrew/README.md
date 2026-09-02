# The afterbrew Companion deployment

Runs this fork at `/srv/docker/apps/companion`, beside the host's other applications. Upstream's
root `docker-compose.yml` is not used directly; see the header of `docker-compose.yml` for what
differs and why.

## Deploy

```sh
docker compose up -d
docker compose cp companiond.json companion:/data/companiond.json   # after any provider change
docker compose up -d --force-recreate companion
```

`companiond.json` is read from `$COMPANION_HOME` (`/data`, a volume), so the copy in this directory
is the reviewed original and has to be pushed in. Editing only the copy inside the volume is a
change nobody reviewed.

## Models

Two systems, and confusing them wastes an evening.

**moxxy** is the agent runtime the CLI drives. Its providers come from a plugin registry that offers
anthropic, claude-code, google, local, openai, openai-codex, xai and zai - **no MiniMax and no
DeepSeek**. Both are OpenAI-compatible, so they can only ride the `openai` provider, which takes one
base URL. MiniMax has it, because a subscription fallback costs nothing where DeepSeek is metered.

**The `runtime` module** is Companion's own agent runtime, and it reads `modelProviders` from
`companiond.json`. It holds all three at once, which is why it is installed:

| id | endpoint | plan |
|---|---|---|
| `minimax` | `https://api.minimax.io/v1` | subscription |
| `zai-coding` | `https://api.z.ai/api/coding/paas/v4` | GLM Coding Plan |
| `deepseek` | `https://api.deepseek.com/v1` | pay as you go, $5 account ceiling |

Credentials are taken by `apiKeyEnv` indirection, so no key is written into `companiond.json`; the
values live in `.env` and are read by the daemon.

### Traps worth knowing

**GLM reasons by default and nothing asks it not to.** moxxy sends a reasoning parameter only
when `context.reasoning` is an object carrying an `effort`; unset, it sends none, and Z.AI's
GLM 5.x reasons anyway. Measured against the Coding Plan endpoint with a 20-token cap: no
parameter returns `finish_reason: "length"`, empty `content` and a full `reasoning_content`,
while both `reasoning_effort: "low"` and `thinking: {"type": "disabled"}` answer normally. On an
agent loop that is not a curiosity - a worker spends its whole output budget thinking, hits
`max_tokens`, and finishes having changed nothing. Set it:

```sh
moxxy config set context.reasoning '{"effort":"low"}'
```

It has to be set in the home the GATEWAY reads (`MOXXY_HOME`, i.e. Companion's isolated home),
not only in the daily home `moxxy config` writes to by default.

**The Z.AI Coding Plan caps usage over a rolling five hours.** Exhausting it returns `429`
code `1308` naming the reset time, and the whole GLM tier goes with it - every model on the
plan shares the cap, so falling back from `glm-5.3` to `glm-5.2` does not route around it.
MiniMax is a separate subscription and stays available.


**`moxxy provision` offers a provider that does not exist.** Its list advertises `zai-plan`; the
plugin ships `zai` and `zai-coding-plan`. Provisioning `zai-plan` succeeds, writes the config, stores
the key - and then every run fails with "provider not registered", naming the provider just
configured. Use `moxxy config set plugins.provider.default zai-coding-plan` instead.

**The same Z.AI key is needed under two names.** `ZAI_API_KEY` for `companiond.json`'s `apiKeyEnv`,
`ZAI_CODING_PLAN_API_KEY` for the moxxy provider. They are not interchangeable.

**Z.AI's general endpoint is not the subscription.** `/api/paas/v4` answers `429 Insufficient
balance`; the Coding Plan is served at `/api/coding/paas/v4`.

**MiniMax reasons inline.** It returns `<think>` blocks in the completion body and, on a large
prompt, will spend its whole token budget reasoning and never write an answer. Where it is reached
through an OpenAI-compatible gateway, pass `thinking: {"type": "disabled"}`.

## The lane's reviewer

Octopus reviews the pull requests the autonomous lane opens. Three variables, all in `.env`:

| Variable | Without it |
|---|---|
| `COMPANION_OCTOPUS_URL` | No review is started; the board raises a blocker |
| `COMPANION_OCTOPUS_TOKEN` | Same |
| `COMPANION_OCTOPUS_LOGIN` | The board cannot tell whether Octopus is a given flow's reviewer, and answers permissively, so a flow that nominated a person or another bot still gets Octopus started |

The login is read independently of the other two, because whether Octopus is the reviewer is
knowable without being able to reach it. Compared case-insensitively, with a trailing `[bot]`
ignored on either side.

## The first admin

A clean volume writes a one-time capability to `/data/bootstrap-token` (mode 600):

```sh
docker compose exec -T companion cat /data/bootstrap-token
```

Then complete the form at `http://127.0.0.1:8901` over an SSH tunnel. The token is consumed once an
account exists.

## What this fork adds

The merge refusal: `merge` steps are refused **at execution**, by the instance, whatever a pipeline
definition, an import, an administrator or a model asks for. See
`modules/code/src/api/merge-refusal.ts`. Verified in the running image with
`modules/code/tests/merge-refusal.test.mjs`.

## Running the tests

The host may not have the right Node. Companion needs 24 (`node:sqlite`), and four `operate` tests
need `git`, which `node:24-alpine` does not ship:

```sh
docker run --rm -v $PWD:/w -w /w/modules/code node:24-alpine \
  sh -c 'apk add --no-cache git >/dev/null && node --test tests/*.test.mjs'
```
