# BYOK: model providers Companion does not have to know about

The built-in harness ([`builtin-harness.md`](builtin-harness.md)) needs a model
to call. The obvious way to give it one is to add a provider package per vendor
and a branch per name, and it is the wrong way: an organisation that wants to
run Companion against its own gateway, its own Azure deployment or its own vLLM
box would then be waiting for a Companion release to add a name.

So the design goal is stated as an invariant rather than a feature:

> **The runtime knows no provider names and carries no defaults.** It is handed
> a provider kind, an endpoint, a credential, a model id and a bag of options at
> spawn time. If it is handed nothing, the turn fails. It never falls back to an
> environment variable it happened to find.

Everything below follows from that. The consequence worth stating first: this is
also what finishes the air-gapped story. `ENTERPRISE.md` §8 names two blockers
for a genuinely disconnected deployment, and "AI agent runs reach a model
provider" is one of them. An internal endpoint is just another record here.

## One SDK, and the provider is a record

We stay inside the Vercel AI SDK for all of it, including its first-party
provider packages (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/azure`,
`@ai-sdk/openai-compatible`). That is what makes the invariant affordable:
somebody else already owns the request shapes, the streaming, the tool-call
protocol and the per-vendor quirks, so the only thing left for us is a table.

The agent loop therefore contains **exactly one place** that names a vendor, and
it is a lookup, not a branch:

```ts
type ProviderFactory = (spec: ResolvedModelSpec) => LanguageModel;

const FACTORIES: Record<string, ProviderFactory> = {
  anthropic: (s) => createAnthropic({ baseURL: s.baseUrl, apiKey: s.apiKey, headers: s.headers, fetch: s.fetch })(s.model),
  openai: (s) => createOpenAI({ baseURL: s.baseUrl, apiKey: s.apiKey, headers: s.headers, fetch: s.fetch })(s.model),
  azure: (s) => createAzure({ resourceName: …, apiVersion: …, apiKey: s.apiKey, fetch: s.fetch })(s.model),
  'openai-compatible': (s) => createOpenAICompatible({ name: s.providerId, baseURL: s.baseUrl, apiKey: s.apiKey, headers: s.headers, queryParams: s.query, fetch: s.fetch })(s.model),
};
```

Everything above that line is data. A provider record says which factory, with
what endpoint and credential:

```ts
/** Contract shape. Crosses to the browser, and therefore never carries a key. */
interface ModelProviderRecord {
  readonly id: string;              // 'acme-gateway'
  readonly label: string;           // 'ACME internal gateway'
  /** Which factory. Open-ended: a plugin may add one. */
  readonly kind: ProviderKind;
  readonly baseUrl: string | null;  // null only where the SDK's default is meant
  /** Non-secret extras: 'anthropic-beta', a tenant id, a routing header. */
  readonly headers: Readonly<Record<string, string>>;
  /** Query passthrough, for gateways that version or route that way. */
  readonly query: Readonly<Record<string, string>>;
  /** Set/unset only. The value never leaves the daemon, per the config rule. */
  readonly hasKey: boolean;
  readonly models: readonly ModelRecord[];
  /** Same shape runners use: instance-wide, or only these workspaces. */
  readonly scope: 'shared' | { readonly workspaces: readonly string[] };
  readonly enabled: boolean;
  /** Declared in configuration rather than clicked: read-only in the UI. */
  readonly managed: boolean;
}

type ProviderKind = 'anthropic' | 'openai' | 'azure' | 'openai-compatible' | (string & {});
```

The open tail on `ProviderKind` is deliberate and load-bearing for the same
reason `HarnessEventType` has one: a provider this build has never heard of has
to be expressible, because the thing that adds it is a plugin, not a release.

Four kinds cover the field, and only one of them exists because a vendor is
genuinely different rather than because it is a famous name:

| The operator has | Record |
|---|---|
| Anthropic API | `anthropic`, default endpoint |
| An internal Anthropic-compatible gateway | `anthropic`, their `baseUrl` |
| OpenAI | `openai` |
| Azure OpenAI or AI Foundry deployments | `azure` (the deployment and api-version shape is its own, see below) |
| Foundry's inference endpoint, LiteLLM, Portkey, OpenRouter, an APIM front door | `openai-compatible`, their URL |
| vLLM, Ollama, llama.cpp, TGI on the cluster | `openai-compatible`, an internal URL |
| Groq, Together, Fireworks, DeepSeek, xAI, Mistral | `openai-compatible`, their URL |

`openai-compatible` is the escape hatch that makes the last three rows cost
nothing, and it is why the list of kinds does not have to grow with the market.
`azure` earns its place for a concrete reason rather than brand recognition: the
deployment name sits in the URL path and the API is versioned by a query
parameter, so the id an operator selects is a deployment rather than a model.
Forcing that through `openai-compatible` produces a record that works for
exactly one model, which is the kind of trap that looks configured and fails on
the second model somebody adds.

None of the other rows needed a line of Companion code. That is the test this
design has to pass.

## A model is qualified, and priced by whoever configured it

```ts
interface ModelRecord {
  /** Provider-native id, sent verbatim. Never normalised, never mapped. */
  readonly id: string;
  readonly label: string | null;
  /** Needed for compaction, so it is declared rather than guessed. */
  readonly contextWindow: number | null;
  /** USD per million tokens. Null makes every run on it unpriced, loudly. */
  readonly inputPerMTok: number | null;
  readonly outputPerMTok: number | null;
  readonly cachedInputPerMTok: number | null;
  /** What a probe actually observed, not what the operator hoped. */
  readonly probed: {
    readonly tools: boolean;
    readonly streaming: boolean;
    readonly reasoning: boolean;
    readonly at: number;
  } | null;
  /** Verbatim to the SDK's providerOptions for this model. Opaque here. */
  readonly options: Readonly<Record<string, unknown>> | null;
}
```

**Model references become qualified: `providerId:modelId`.** Two providers can
serve `gpt-4o` and a bare id then means whichever record happened to sort first,
which is exactly the ambiguity a task pin must not have. Existing bare ids on
run rows, task pins and preferred models keep resolving to the first enabled
provider that lists them, and are rewritten qualified on the next save: additive
migration, no rewrite pass.

**Pricing.** `modules/operate/src/contract/model-pricing.ts` opens with a
warning that it is THE pricing table and nothing else may carry a price. BYOK
breaks that as written, because nobody can price an arbitrary endpoint, so the
rule has to be restated rather than quietly violated: `priceFor` consults the
provider registry first and falls back to the built-in table. One function, one
answer, still one place that decides. A model with no price anywhere contributes
zero to the ceiling and the budget card says the total is partial, which is the
behaviour that already exists for non-Anthropic ids.

That gives the operator a real decision at enable time: price the model, or
accept that this instance's spend ceiling cannot see it.

## What actually reaches the child

The record is configuration. What the runtime receives is a resolved spec, built
in the parent at spawn, never rendered to a browser, never written to a log:

```ts
interface ResolvedModelSpec {
  readonly providerId: string;
  readonly kind: ProviderKind;
  readonly baseUrl: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly model: string;
  readonly sampling: { temperature?: number; topP?: number; maxOutputTokens?: number };
  readonly providerOptions: Readonly<Record<string, unknown>>;
  readonly transport: { timeoutMs: number; maxRetries: number };
  readonly limits: { maxSteps: number; contextWindow: number | null; toolOutputChars: number };
}
```

Three option buckets rather than one soup, because they fail differently:

- **`sampling`** is what the SDK normalises across providers. Portable,
  validated, and the same field means the same thing everywhere.
- **`providerOptions`** is the SDK's own per-provider escape hatch (thinking
  budgets, reasoning effort, service tier, cache control) and is passed verbatim
  as `Record<string, unknown>` on purpose. Validating it per vendor would mean
  shipping a schema per vendor, which is the coupling this whole document exists
  to avoid. A wrong key surfaces as a provider error on the first turn, which is
  an honest failure.
- **`transport`** is timeouts, retries and headers, and belongs to us rather
  than to the model.

The spec reaches the child over its stdin as the first frame, not as argv (argv
is world-readable in `ps`) and not as env when the key is in it (env leaks
through crash dumps and child processes).

## Extension, in three tiers

Most of the field needs no code. Naming the tiers keeps a request from being
answered at the wrong one.

**Tier 1: configuration only.** The kind is one of the four and the difference
is a URL, a header and a key. Everything in the table above. No release, no
plugin, no restart beyond re-reading configuration.

**Tier 2: the credential is not a static key.** Entra ID tokens instead of an
Azure key, SigV4 signing, a short-lived OAuth token, mTLS, a corporate CA. Every
AI SDK provider factory accepts a custom `fetch`, so this is a **signing fetch
contributed on the parent side** and the child is unchanged. The parent is also
where the proxy dispatcher and `NODE_EXTRA_CA_CERTS` already apply, so it is the
layer that already knows about corporate networks. This is the same seam the
keyless-child design uses, which is a good sign it is in the right place.

**Tier 3: a provider package this build does not carry.**
`@ai-sdk/amazon-bedrock`, `@ai-sdk/google-vertex` and friends exist; they are
simply not dependencies of this module, because shipping every one of them would
put the whole vendor market in an image most instances never call. A plugin
registers a factory under a new `kind`, loaded from
`$COMPANION_HOME/providers/*.mjs` by dynamic import in the child: the same
"unpack a directory, no registry access" install path out-of-tree modules
already use, and viable in an air-gapped install.

Because we stayed inside one SDK, tier 3 is `npm pack` plus a six-line factory
rather than an implementation of somebody's protocol. That is the whole return
on staying inside one SDK.

## Where the key lives

`modules/code/src/api/migrations.ts` version 10 already solved this exact
problem for hidden pipeline variables, and the reasoning in its comment applies
unchanged: the table holds **who provided the credential, for which workspace,
and whether anyone else may use it**, and the value stays in the kernel's
`SecretStore` under a generated key.

So: a `model_providers` table owned by operate, with the key in `ModuleSecrets`
at `provider:<id>:key`. Three properties come for free, and none of them would
if this were a bespoke column:

- an instance that moved secrets to Vault keeps these there too, because it is
  the same seam (`ENTERPRISE.md` §6);
- the value is redacted from every config read exactly like a declared secret;
- uninstall clears it with everything else.

Manifest `kind: 'secret'` config is the wrong home despite being the obvious
one: it is a flat form of fixed keys, and BYOK is a list whose length the
manifest cannot know.

## Configuration as code

An organisation deploying this in Kubernetes will not click providers into a
form, and a form-only design silently makes the product harder to deploy than it
looks. Providers are therefore declarable in `$COMPANION_HOME/companiond.json`
(or a file named by `COMPANION_PROVIDERS_FILE`), with the credential taken by
indirection so it can come from a mounted secret:

```json
{
  "modelProviders": [
    {
      "id": "acme-gateway",
      "label": "ACME gateway",
      "kind": "openai-compatible",
      "baseUrl": "https://llm.acme.internal/v1",
      "auth": { "kind": "bearer" },
      "apiKeyEnv": "ACME_LLM_KEY",
      "models": [
        { "id": "claude-sonnet-5", "contextWindow": 200000, "inputPerMTok": 3, "outputPerMTok": 15 }
      ]
    }
  ]
}
```

A declared provider is `managed: true` and read-only in the UI, which is how
every GitOps-shaped product behaves and stops the two sources of truth from
fighting. `apiKeyEnv` is read by the **daemon** into the secret store, which is
not the same thing as the child picking up a stray environment variable: the
invariant at the top of this page still holds.

## Detecting rather than trusting

Two questions the operator cannot answer reliably about their own endpoint, so
Companion asks it instead, in the spirit of `harness-detect.ts`.

**Which models are there.** Every kind exposes a model list (`GET /v1/models`),
so "fetch models" fills the list and the operator ticks which ones are permitted.
Discovery is a convenience; the ticked subset is policy, and free text stays for
an endpoint that lists nothing.

**Whether a model can do the job.** An agent harness without tool calling is
useless, and plenty of endpoints advertise a model that cannot do it, or cannot
stream, or drops `tool_choice`. So a **Test** runs a real round trip: a one-token
generation, a trivial tool call, and a streamed token. It records what it
observed on the model record and names what failed. A model whose tool probe
failed can serve prompt-only one-shots and is refused for tool-using work,
rather than being offered and failing on its first real run.

## Resolution, and one cascade rather than two

At spawn the parent resolves, in this order: the run's explicit
`providerId:modelId`, the unit of work's preferred model, the task pin, the
instance default. Then it checks the record is enabled, in scope for the run's
workspace, and permitted by the runner's own provider policy, which already
exists.

**No provider failover in v1, deliberately.** "If the gateway 429s, try the next
provider" is an obvious ask and it would give this instance two independent
cascades: one for machines and one for models. `runners.md` says a refusal names
the fence that rejected it so that "why did this not run here" has one answer,
and a second cascade takes that away. Retries within one provider (`transport`)
are a different thing and are in.

**Which machine holds the key** is the one place the remote runner intrudes.
The local runner uses instance providers. A remote runner uses **its own** by
default, exactly as `COMPANION_RUNNER_GITHUB_TOKEN` overrides the daemon's git
credential, because the runner endpoint is plain HTTP unless the operator wrote
`https://` and shipping a provider key over that would be a downgrade. A runner
may be flagged to accept instance-supplied specs, and that flag is refused on a
non-https endpoint. Fail loudly there; do not degrade.

## The security perimeter

- `baseUrl` is admin configuration behind `providers:manage`, threaded with
  `pnpm acl`. It is never derived from a prompt, a repository file or a run
  argument, so an agent cannot point the runtime at a host of its choosing.
- The key is never returned to a browser (set/unset flag), never in argv, never
  in a log line. Provider error bodies are redacted before they reach a
  transcript, because they routinely echo request headers.
- Provider create, update and delete are ordinary mutating routes, so the
  router's audit choke point covers them with no extra instrumentation.
- The child holds the key today and does not have to forever: the keyless-child
  design in `builtin-harness.md` phase 9 moves it behind a loopback proxy, and
  tier 2 signing already lives on that side of the line.

## What this costs the rest of the product

Three things get harder, and all three are better named now than discovered
later.

**The Providers page grows a second source.** Today it renders what each
machine's runtime reported. Companion-owned providers are a different origin
with different ownership, and rendering them in one undifferentiated list would
make "where do I change this" unanswerable. They are additive and must be
visibly distinct.

**The spend ceiling depends on operator input.** An unpriced model is invisible
to it. That is already true of every non-Anthropic id, so the change is one of
degree, but BYOK makes it the common case rather than the exception.

**Compaction depends on a declared context window.** A wrong number is a
provider error mid-run rather than a graceful trim. Default conservative, and
prefer the probe's answer when the endpoint reports one.

## Decisions still open

**Which AI SDK provider packages the module depends on.** Four kinds is the
recommendation and it covers the three named customers plus every gateway. Each
additional first-party package is a dependency in an image, and the plugin path
exists so that adding one is not a release. Resist growing this list by
popularity; grow it when a paying deployment cannot be served by
`openai-compatible`.

**Whether scope ships in v1.** Instance-wide is simplest, per-workspace is the
actual enterprise ask (chargeback, data residency, one team's key not paying for
another's), and the `pipeline_secrets` precedent shows the shape costs a column
and a filter. Recommendation: ship the resolver taking the workspace from day
one, and the storage with it, because retrofitting scope onto a resolution path
that never had it is the expensive version.

**Whether an unpriced model may be enabled at all.** Refusing is coherent with
"a ceiling that silently never triggers is worse than no ceiling". Allowing with
a loud partial marker is coherent with not blocking an operator who does not use
budgets. Recommendation: allow, and refuse only when a budget is configured.
