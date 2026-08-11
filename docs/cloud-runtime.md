# Companion fully hosted: the runtime module

The target is an organisation that runs Companion as a service for itself, with
no engineer ever logging into the box, bringing its own model access: one has
Azure AI Foundry, one has an OpenAI account, one has an Anthropic API key. All
three get a working instance from a container image and a secret.

Two documents sit under this one. [`builtin-harness.md`](builtin-harness.md) is
the agent loop that removes the installed-CLI dependency;
[`model-providers.md`](model-providers.md) is the BYOK contract that removes
the named-vendor dependency. This one is about **shipping** them: what is a
module, what is a package, what a slim install keeps, and the flow from
`docker run` to the first agent run.

## Not in slim, and off until installed

The npx path and the default Docker image serve a maintainer who already has
`claude` or `moxxy` installed and signed in. Which builds carry the runtime is
named in `profiles/*.json`:

| Profile | Runtime module |
|---|---|
| `slim` (default Docker image) | absent |
| `full` (the published npx CLI is a full build) | present, lands as **Available** |
| `cloud` | present, lands as **Available** |

In every build that carries it, the module declares `autoInstall: false`:
model credentials are money and access, and an instance should acquire the
ability to spend them deliberately, never by upgrading. So even the `cloud`
image boots with the slim baseline running and the runtime **Available**, and
turning it on is one explicit step (`install` also enables):

```sh
companion module install runtime
```

The module is OSS and carries no entitlement gate.

## Module and package, and why it has to be both

```
modules/runtime            @companion/module-runtime
  control plane            provider records, secrets, routes, RBAC, the
                           Model providers page, MCP server records, harness
                           registration, spawn on the local runner
     depends on
        ▼
packages/runtime           @moxxy/companion-runtime
  execution                the agent loop, the tool set, the AI SDK providers.
                           A parent half (spawn + Harness) and a child half
                           (the subprocess entry). No Companion imports
                           beyond the shared types.
        ▲
     depends on
apps/companion-runner      the remote data plane: bundles the same runtime
                           package and spawns the same child
```

The split is forced by `companion-runner`, which loads no modules and must run
the same loop. A module cannot be its dependency; a package can be a dependency
of both. And the control-plane half cannot be in the package, because provider
records need a table, migrations, routes, RBAC and a page, which are module
things.

The harness registry is open (the same open-registry pattern as permissions,
WS messages, services and bus events): the module registers the `companion`
harness on enable and takes it back out on disable, and the local runner
backend dispatches on the registry.

### Spawning the child in three delivery vehicles

The runtime spawns one subprocess per run. Where that file is differs by how
Companion was delivered (`modules/runtime/src/api/harness.ts`):

| Vehicle | The child is |
|---|---|
| Source checkout | the package's own child entry, resolved through node_modules |
| CLI bundle and Docker | `dist/agent.js` beside the bundle, emitted by `apps/companion-cli/build.mjs` only when the built profile contains the runtime module |
| Out-of-tree module | the package inside that module's own install directory, resolved as in a checkout |
| companion-runner | its own bundle's agent entry, from the same package |

## Provider records live in the module, prices are snapshotted on the run

The runtime module owns the `model_providers` table and the credential, per
[`model-providers.md`](model-providers.md). Two things reach operate, which
does not depend on it, and only one of them needed a seam.

**Models** need none: the harness reports its catalog through the same
detection path every runtime uses, and the Providers page renders it.

**Prices** are snapshotted: the resolved unit price is written onto the run
row at creation (`runs_price_snapshot` in
`modules/operate/src/api/migrations.ts`), so a completed run prices itself
with no registry lookup, and a month-old run keeps the price it actually ran
at when the operator edits the record. This is the same run-time snapshotting
the pipeline step library does for step specs.

## The flow, end to end

### For the platform team, once

```sh
docker build --build-arg PROFILE=cloud --build-arg INSTALL_MOXXY=false -t companion:cloud .
```

Run it with a persisted `/data`, `COMPANION_PUBLIC_URL` set (OIDC needs it;
webhook delivery takes the same host in operate's `webhookPublicUrl`), the
admin seed variables, and the provider secret mounted. Then, inside the
container or over the CLI, the one deliberate step:

```sh
companion module install runtime
```

Providers can be clicked in or declared in configuration. A hosted deployment
declares them, so the container is reproducible:

```json
{
  "modelProviders": [
    { "id": "azure", "label": "Azure AI Foundry", "kind": "azure",
      "baseUrl": "https://acme.openai.azure.com",
      "apiVersion": "<the version the resource serves>",
      "apiKeyEnv": "AZURE_OPENAI_KEY",
      "models": [{ "id": "<deployment name>", "contextWindow": 200000,
                   "inputPerMTok": 3, "outputPerMTok": 15 }] }
  ]
}
```

### For the three companies

All three are one record and no code, because `@ai-sdk/anthropic`,
`@ai-sdk/openai` and `@ai-sdk/azure` are dependencies of the runtime package.

**Anthropic API.** `kind: anthropic`, the default endpoint, key in the secret
store. This is the one case where the built-in pricing table already carries
the prices, so the spend ceiling works with no operator input.

**OpenAI.** `kind: openai`. The model list is fetchable from the endpoint.
Prices are operator-declared, since the built-in table carries Anthropic list
prices only, and that is the first thing to get wrong here: an unpriced model
makes the ceiling partial.

**Azure AI Foundry.** `kind: azure`, the resource URL, the api-version the
resource serves, and **deployment names as model ids**. That last part is why
`azure` is its own kind: the operator picks a deployment, not a model, and
routing it through `openai-compatible` with a hand-built URL produces a record
that works for exactly one deployment. Foundry's non-OpenAI catalogue, served
from the inference endpoint rather than a deployment, is an
`openai-compatible` record pointed at that URL.

### For the administrator, in the UI

1. **Settings, Model providers, Add provider.** Kind, URL, auth, key. The key
   goes to the secret store and never comes back.
2. **Fetch models**, tick the permitted ones, declare context window and price.
3. **Test.** One real round trip per model: does it answer, and can it call a
   tool. What passed is recorded on the model record and shown wherever the
   model is offered.
4. **Runners.** The built-in harness appears in the machine's harness set and,
   unlike the other three, can never read as absent. Put it first, or first
   for this machine only.
5. **Run something.** The natural first target is a one-shot: issue triage or
   a slop verdict, where a bad answer is a visible refusal rather than a bad
   diff.

### Scaling out

The daemon stays one node, which [`ENTERPRISE.md`](../ENTERPRISE.md) §2
decided and this does not revisit. Execution scales by adding
`companion-runner` replicas, and with this module they are plain containers:
no CLI to install, no interactive sign-in, no per-machine provider setup.

The one rule that is not softened: **a runner holds its own provider
credentials unless its endpoint is https.** The runner protocol is plain http
by default, so a daemon that shipped an API key over that would be worse than
a machine-local credential. In a cluster, runner traffic is usually in-mesh
and the rule is easy to satisfy; the refusal is for the operator who exposed a
runner across the internet and did not notice.

A cold replica clones every repository it is given work for, so give the pool
a volume or accept a slow first run per repo.

## What is still not solved

**Multi-tenant is not on this page.** One daemon, one data directory, one
organisation. A provider serving many customers runs an instance per customer.
Per-workspace provider scoping gives a single organisation internal
separation, which is a different and smaller thing.

**Someone still holds the keys.** BYOK means the customer's key sits in the
instance's secret store. For a self-hosted customer that is their own box. For
a vendor-hosted deployment it is the vendor's, and the honest answers are the
secret-store seam pointed at the customer's KMS, or the planned keyless-child
hardening so the key never reaches the process running untrusted repository
content. Neither is shipped.

**It is the floor, not the ceiling.** The built-in loop makes every instance
able to run agent work; it does not claim to out-code the dedicated coding
CLIs. An operator who wants one installs it and picks it per runner, exactly
as before. See [`builtin-harness.md`](builtin-harness.md).
