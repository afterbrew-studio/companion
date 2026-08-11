# BYOK: model providers

The built-in harness ([`builtin-harness.md`](builtin-harness.md)) needs a model
to call. Companion does not hard-code vendors for it; a provider is a **record**
an operator configures, so an organisation running its own gateway, its own
Azure deployment or its own vLLM box is a configuration change, not a Companion
release.

One invariant holds all of it together (`packages/runtime/src/spec.ts`):

> **The runtime knows no provider names and carries no defaults.** It is handed
> a provider kind, an endpoint, a credential, a model id and a bag of options
> at spawn time. If it is handed nothing, the turn fails. It never falls back
> to an environment variable it happened to find.

This is also part of the air-gapped story: an internal endpoint is just
another record.

## One SDK, and the provider is a record

The runtime stays inside the Vercel AI SDK, including its first-party provider
packages (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/azure`,
`@ai-sdk/openai-compatible`). Somebody else owns the request shapes, the
streaming and the tool-call protocol, so the only thing left for Companion is a
lookup table: exactly one place in the loop names a vendor
(`packages/runtime/src/child/providers.ts`), and it maps a `kind` to a factory.

Four kinds cover the field:

| The operator has | Record |
|---|---|
| Anthropic API | `anthropic`, default endpoint |
| An internal Anthropic-compatible gateway | `anthropic`, their `baseUrl` |
| OpenAI | `openai` |
| Azure OpenAI or AI Foundry deployments | `azure` (deployment names as model ids, `apiVersion` on the record) |
| Foundry's inference endpoint, LiteLLM, Portkey, OpenRouter, an APIM front door | `openai-compatible`, their URL |
| vLLM, Ollama, llama.cpp, TGI on the cluster | `openai-compatible`, an internal URL |
| Groq, Together, Fireworks, DeepSeek, xAI, Mistral | `openai-compatible`, their URL |

`openai-compatible` is the escape hatch that keeps the list of kinds from
growing with the market. `azure` earns its place for a concrete reason rather
than brand recognition: the deployment name sits in the URL path and the API is
versioned by a query parameter, so the id an operator selects is a deployment
rather than a model.

The `ProviderKind` union is deliberately open (`string & {}`), and
`@moxxy/companion-runtime/plugin` exports `registerProviderFactory` so a
provider package this build does not carry (Bedrock, Vertex, and friends) can
be contributed as a factory under a new kind without shipping the whole vendor
market in every image.

## The records

A provider record (`modules/runtime/src/contract/index.ts`) carries the id,
label, kind, `baseUrl`, non-secret `headers` and `query` passthrough,
`apiVersion` (Azure), `factoryOptions`, whether a key is stored (`hasKey`, a
set/unset flag: the value never crosses to a browser), its models, a workspace
scope (`workspaceIds`, instance-wide when null, mirroring runners), and
`enabled`.

Each model record carries the provider-native id (sent verbatim, never
normalised), an optional label, the declared `contextWindow` (needed for
compaction, so it is declared rather than guessed), prices in USD per million
tokens (`inputPerMTok` / `outputPerMTok`), what the probe observed, and an
opaque `options` bag passed verbatim to the SDK's `providerOptions`.

**Model references are qualified: `providerId:modelId`.** Two providers can
serve the same model id, and a bare id would mean whichever record happened to
sort first. A bare id still resolves, to the first enabled provider that lists
it.

**Pricing.** `modules/operate/src/contract/model-pricing.ts` carries Anthropic
list prices and stays the default for the ids it knows; a BYOK instance prices
from its own model records. The resolved unit price is snapshotted onto the run
row at creation, so a completed run prices itself and correcting a provider
record never reprices money already spent. A model with no price anywhere
contributes zero to the spend ceiling and the budget card says the total is
partial. That gives the operator a real decision at configuration time: price
the model, or accept that this instance's spend ceiling cannot see it.

## What actually reaches the child

The record is configuration. What the runtime receives is a `ResolvedModelSpec`
built in the parent at spawn: kind, endpoint, credential, model id,
`contextWindow`, sampling, `providerOptions`, `factoryOptions`. It is never
rendered to a browser and never written to a log, and it reaches the child as
the first frame over stdin, not as argv (argv is world-readable in `ps`).

The option buckets are separate because they fail differently. `sampling` is
what the SDK normalises across providers: portable and validated.
`providerOptions` is the SDK's own per-provider escape hatch (thinking budgets,
reasoning effort, cache control), passed verbatim on purpose: validating it per
vendor would mean shipping a schema per vendor, and a wrong key surfaces as a
provider error on the first turn, which is an honest failure.

## Where the key lives

The runtime module owns the `model_providers` table, and the credential lives
in the kernel's secret store under the module's secret namespace. Three
properties come for free:

- an instance that moved secrets to Vault keeps these there too, because it is
  the same seam ([`ENTERPRISE.md`](../ENTERPRISE.md) §6);
- the value is redacted from every config read (the record carries only
  `hasKey`);
- uninstalling the module clears it with everything else.

Provider create, update and delete are ordinary mutating routes behind their
own permission, so the router's audit choke point covers them with no extra
instrumentation. `baseUrl` is admin configuration: it is never derived from a
prompt, a repository file or a run argument, so an agent cannot point the
runtime at a host of its choosing.

## Configuration as code

An organisation deploying in Kubernetes will not click providers into a form.
Providers (and MCP servers) are declarable in `$COMPANION_HOME/companiond.json`,
with the credential taken by indirection so it can come from a mounted secret:

```json
{
  "modelProviders": [
    {
      "id": "acme-gateway",
      "label": "ACME gateway",
      "kind": "openai-compatible",
      "baseUrl": "https://llm.acme.internal/v1",
      "apiKeyEnv": "ACME_LLM_KEY",
      "models": [
        { "id": "claude-sonnet-5", "contextWindow": 200000, "inputPerMTok": 3, "outputPerMTok": 15 }
      ]
    }
  ]
}
```

Declared providers are adopted (created, or updated in place) when the module
activates. `apiKeyEnv` is read by the **daemon** into the secret store, which
is not the same thing as the child picking up a stray environment variable:
the invariant at the top of this page still holds.

## Detecting rather than trusting

Two questions the operator cannot answer reliably about their own endpoint, so
Companion asks it instead.

**Which models are there.** "Fetch models" asks the endpoint
(`GET /v1/models`) and the operator ticks which ones are permitted. Discovery
is a convenience; the ticked subset is policy, and free text stays for an
endpoint that lists nothing. Azure is the one kind that cannot answer (its
deployments live behind the management API), and it says so instead of
returning an empty list that would read as "none".

**Whether a model can call a tool.** An agent harness without tool calling is
useless, and plenty of endpoints advertise a model that cannot do it. **Test**
(`companion provider test <id> --model <id>`, or the button on the Providers
page) runs one real round trip: a short generation that must call a trivial
tool. What it observed is recorded on the model record and shown wherever the
model is offered, so "the gateway lists it" and "it can do the job" stay
distinguishable.

## Resolution, and one cascade rather than two

At spawn the parent resolves the run's model reference against enabled,
in-scope provider records. **There is no provider failover, deliberately.**
"If the gateway 429s, try the next provider" would give an instance two
independent cascades, one for machines and one for models, and
[`runners.md`](runners.md)'s rule that a refusal names the fence that rejected
it would stop having one answer. Retries within one provider are transport
policy and are a different thing.

**Which machine holds the key** is the one place the remote runner intrudes.
The local runner uses instance providers. A remote runner uses **its own** by
default (`COMPANION_RUNNER_PROVIDER_*`), because the runner endpoint is plain
http unless the operator wrote `https://`, and shipping a provider key over
plain http would be a downgrade from today. An instance-supplied spec crosses
only to an https runner; the refusal is loud, not a degradation.
