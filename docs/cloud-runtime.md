# Companion fully hosted: the runtime module

The target is an organisation that runs Companion as a service for itself, with
no engineer ever logging into the box, bringing its own model access: one has
Azure AI Foundry, one has an OpenAI account, one has an Anthropic API key. All
three should get a working instance from a container image and a secret.

Two documents sit under this one. [`builtin-harness.md`](builtin-harness.md) is
the agent loop that removes the installed-CLI dependency;
[`model-providers.md`](model-providers.md) is the BYOK contract that removes the
named-vendor dependency. This one is about **shipping** them: what is a module,
what is a package, what a slim install keeps, and the flow from `docker run` to
the first agent run.

## Not in slim, and this is the right call

The npx path is a maintainer on a laptop who already has `claude` or `moxxy`
installed and signed in. Compiling an agent loop, a provider registry and a
credential store into that build would add surface every such user carries and
none of them asked for. `profiles/*.json` exists precisely so that the module
set of a build is a decision rather than an accident.

| Profile | Runtime module | Who it is for |
|---|---|---|
| `slim` (npx default) | absent | a maintainer with a CLI already installed |
| `full` | present, `autoInstall: false` | anyone who wants it, one `module install` away |
| `cloud` (new) | present, installed and enabled | a hosted or platform deployment |

`cloud` is one more JSON file next to the three that exist. It is `slim` plus
`runtime`, plus `oidc` and `notify`, because an instance nobody logs into
locally needs SSO and an alert path anyway. That is the profile the hosted image
is built from.

**OSS or entitled.** The gate exists and nothing uses it (`ENTERPRISE.md` §7).
The temptation is to make this the first entitled module, and I would not: it is
the thing that makes Companion work at all without an external CLI, so putting
it behind a licence makes the OSS product worse in the one place people evaluate
it. Entitle what an organisation needs and an individual does not, which is the
layer above: per-workspace BYOK with chargeback attribution, provider policy
across a fleet, and per-run isolation. Those are a second module (`runtime-pro`
or similar) that depends on this one and is genuinely enterprise-shaped.

## Module and package, and why it has to be both

The user-facing ask was "a module plus a package", and it is also what the
architecture forces:

```
modules/runtime            @companion/module-runtime
  control plane            provider records, secrets, routes, RBAC, UI,
                           model catalog, harness registration, spawn on
                           the local runner
     depends on
        ▼
packages/runtime           @moxxy/companion-runtime
  execution                the agent loop, the tool set, the AI SDK providers.
                           A parent half (spawn + Harness) and a child half
                           (the subprocess entry). No Companion imports
                           beyond the shared types.
        ▲
     depends on
apps/companion-runner      the remote data plane: gains a spawn path for
                           harness id 'companion', and nothing else
```

The split is forced by `companion-runner`, which loads no modules and must run
the same loop. A module cannot be its dependency; a package can be a dependency
of both. And the control-plane half cannot be in the package, because provider
records need a table, migrations, routes, RBAC and a page, which are module
things.

### The prerequisite that moves

`harness-abstraction.md` phase 7 ("harness as a module") was written as an
optional later cleanup. With this shape it becomes a **prerequisite**: a module
cannot register a harness while `HARNESSES` is a constant array in
`modules/operate/src/api/harnesses.ts` that names its three implementations by
import.

It is a small piece of work and the pattern is everywhere in this codebase
already: an open registry, like permissions, WS messages, services and bus
events. A module calls `defineHarness({ descriptor, create })` in its `onEnable`,
`LocalRunnerBackend` looks the run's harness id up in the registry instead of
branching on two constants, and `describeHarness` keeps answering
`claimsNothing` for an id no longer present, which is exactly the case a
disabled module produces. Do this first, as its own change, with moxxy, Claude
Code and Codex moved onto it and no behaviour change. It should be provably a
no-op, and it is what makes the fourth harness cost nothing structural.

### Spawning the child in three delivery vehicles

The runtime spawns one subprocess per run. Where that file is differs by how
Companion was delivered, and the rule has to be explicit or it will work in a
checkout and fail in the image:

| Vehicle | The child is |
|---|---|
| Source checkout | the package's own `dist/child.js`, resolved from the module's `import.meta.url` through node_modules |
| CLI bundle and Docker | `dist/agent.js`, a **third esbuild entry** in `apps/companion-cli/build.mjs`, emitted only when the built profile contains the runtime module |
| Out-of-tree module | the package inside that module's own install directory, resolved the same way as the checkout |
| companion-runner | its own bundle's `dist/agent.js`, from the same package |

`apps/companion-cli/build.mjs` already emits fourteen named entry points plus a
separate `server.js`, so a third `build()` call is idiomatic here rather than a
new mechanism. The resolution helper tries the on-disk package first and falls
back to the sibling bundle, which covers all four rows with one function and no
configuration.

## Provider records live in the module, prices are snapshotted on the run

The module owns the `model_providers` table and the credential, per
[`model-providers.md`](model-providers.md). Two things have to reach operate,
which does not depend on it, and only one of them needs a seam.

**Models** need none: the harness reports its catalog through `sessionInfo`,
which is the path every runtime already uses and which the Providers page
already renders.

**Prices** would need one, and the better answer is not to have one. Write the
resolved unit price onto the run row at creation, alongside the model. Then a
completed run prices itself with no registry lookup, a month-old run keeps the
price it actually ran at when the operator edits the record, and
`model-pricing.ts` stays THE table for every run with no snapshot. This is the
same run-time snapshotting the pipeline step library already does for step
specs, so it is a pattern this codebase has rather than a new one. The operate
change is two nullable columns and one branch in the estimate.

## The flow, end to end

### For the platform team, once

```sh
docker build --build-arg PROFILE=cloud -t companion:cloud .
```

Then run it with a persisted `/data`, `COMPANION_PUBLIC_URL` set (webhooks and
OIDC need it), the admin seed variables, and the provider secret mounted. No
second volume for a runtime home, because there is no external CLI to hold one:
that is one of the two volumes `ENTERPRISE.md` §2 currently tells operators they
must not lose.

Providers can be clicked in or declared in configuration. A hosted deployment
declares them, so the container is reproducible:

```json
{
  "modelProviders": [
    { "id": "azure", "label": "Azure AI Foundry", "kind": "azure",
      "baseUrl": "https://acme.openai.azure.com",
      "query": { "api-version": "<the version the resource serves>" },
      "apiKeyEnv": "AZURE_OPENAI_KEY",
      "models": [{ "id": "<deployment name>", "contextWindow": 200000,
                   "inputPerMTok": 3, "outputPerMTok": 15 }] }
  ]
}
```

### For the three companies

All three are one record and no code, because `@ai-sdk/anthropic`,
`@ai-sdk/openai` and `@ai-sdk/azure` are already dependencies of the runtime
package.

**Anthropic API.** `kind: anthropic`, the default endpoint, key in the secret
store. Models are the ids they already know, and this is the one case where
`model-pricing.ts` already carries the prices, so the spend ceiling works with
no operator input. It is also the highest-fidelity path, because that provider
carries prompt caching and reasoning blocks rather than flattening them.

**OpenAI.** `kind: openai`. The model list is fetchable from the endpoint.
Prices are operator-declared, since the built-in table carries Anthropic list
prices only, and that is the first thing to get wrong here: an unpriced model
makes the ceiling partial and silent.

**Azure AI Foundry.** `kind: azure`, the resource URL, the api-version the
resource serves, and **deployment names as model ids**. That last part is why
`azure` is its own kind: the operator picks a deployment, not a model, and
routing it through `openai-compatible` with a hand-built URL produces a record
that works for exactly one deployment. Where a resource exposes the newer
OpenAI-compatible route, `openai-compatible` is the simpler record and should be
preferred. Foundry's non-OpenAI catalogue, served from the inference endpoint
rather than a deployment, is an `openai-compatible` record pointed at that URL.

Entra ID sign-in instead of a static key is the one Azure thing that is not
configuration: it is **tier 2** in `model-providers.md`, a token-minting `fetch`
handed to `createAzure`. Worth building early, because the organisations that
ban static keys are exactly the ones asking for a hosted deployment.

### For the administrator, in the UI

1. **Settings, Providers, Add provider.** Wire, URL, auth, key. The key goes to
   the secret store and never comes back.
2. **Fetch models**, tick the permitted ones, declare context window and price.
3. **Test.** A one-token generation, a trivial tool call and a streamed token
   against each ticked model. What passed is recorded on the model; a model
   whose tool probe failed is offered for prompt-only work and refused for
   tool-using work, rather than failing on its first real run.
4. **Runners.** The built-in harness appears in the machine's harness set and,
   unlike the other three, can never read as absent. Put it first, or first for
   this machine only.
5. **Run something.** The natural first target is a one-shot: issue triage or a
   slop verdict, where a bad answer is a visible refusal rather than a bad diff.

### Scaling out

The daemon stays one node, which `ENTERPRISE.md` §2 decided and this does not
revisit. Execution scales by adding `companion-runner` replicas, and with this
module they are plain containers: no CLI to install, no interactive sign-in, no
per-machine provider setup.

The one rule that must not be softened: **a runner holds its own provider
credentials unless its endpoint is https.** The runner protocol is plain HTTP
by default, so a daemon that shipped an API key to it over that would be worse
than today, where the key never leaves the machine it was configured on. In a
cluster, runner traffic is usually in-mesh and the flag is easy to satisfy; the
refusal is for the operator who exposed a runner across the internet and did not
notice.

A cold replica clones every repository it is given work for, so give the pool a
volume or accept a slow first run per repo.

## What is still not solved

Naming these is more useful than a plan that implies the container is the whole
story.

**Multi-tenant is not on this page.** One daemon, one data directory, one
organisation. A provider serving many customers runs an instance per customer.
Per-workspace BYOK gives a single organisation internal separation, which is a
different and smaller thing.

**Someone still holds the keys.** BYOK means the customer's key sits in the
instance's secret store. For a self-hosted customer that is their own box. For a
vendor-hosted deployment it is the vendor's, and the honest answers are the
`SecretStore` seam pointed at the customer's KMS, or the keyless-child design so
the key never reaches the process running untrusted repository content. Both are
already in the plans; neither is v1.

**Quality is unproven.** Everything above is deployment shape. Whether the
built-in loop answers as well as moxxy on real work is phase 1 of
`builtin-harness.md`, measured on the playground's saved evaluations, and it is
the gate the rest of this should not be built ahead of.
