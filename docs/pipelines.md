# Pipelines: authoring, secrets, export and import

A pipeline is an ordered list of steps run against a pull request, an issue, or a
repository. This document covers the parts that are not obvious from the editor:
where secrets live, how a step reads one, how a pipeline moves between instances,
and how to write an importable document by hand.

For the step kinds themselves, open **Pipelines → New pipeline**; each kind
carries its own hint.

---

## 1. Variables, visible and hidden

An `executable` step declares its environment as one list. Each variable is
either visible or hidden, and that single choice decides everything else about
it.

| | Visible | Hidden |
|---|---|---|
| Value stored in | the pipeline definition | the secret store, owned by whoever set it |
| Templated with `{{…}}` | yes | no |
| Readable back in the editor | yes | never; typing replaces |
| Travels in an export | yes | no, only the name |
| Redacted from output and audit | no | yes |

Use visible for things meant to be readable: a registry URL, a flag, a value
handed over from an earlier step. Use hidden for anything that must not be.

The editor rejects a credential-shaped literal in a visible variable, and in the
command, because both are stored and both travel in an export. Ticking "hidden"
is the fix and the error message says so.

### What hidden actually does

On save, the server moves the value into the module's secret store under a
generated key and keeps only that key on the step. The value is in the request
body for exactly as long as it takes to persist it, and is never written back to
a client. An empty hidden field on a later edit means "leave it alone", not
"clear it", the same convention as a password input.

Storage is the kernel's `SecretStore` seam, the same one behind `kind: 'secret'`
module config, so an instance that moved its secrets to Vault keeps these there
too. Keys not referenced by any surviving step are deleted after every write and
delete, so removing a variable or its pipeline removes the value with it.

At run time the visible variables are applied first and hidden ones second, so a
hidden value can never be shadowed by a visible variable of the same name.

### Ownership, and why there is no instance-wide credential

A hidden value records **who supplied it**, **which workspace it belongs to**,
and **who else may use it**:

- `only me` (default): only runs started by the owner resolve it.
- `workspace`: any run in that workspace resolves it. An explicit act of
  delegation, not a side effect of someone else editing the pipeline.

A value from another workspace never resolves, whatever its visibility.

There is deliberately no instance-level option. On a hosted or multi-user
deployment that would pool every profile's publish rights into one credential
nobody is accountable for, which is exactly the shape to avoid. `npm-bootstrap`
carries its token the same way for the same reason; there is no module-config
npm token any more.

**Editing is locked to the owner.** A step holding someone else's credential
cannot be edited by anyone else, because the exfiltration path is trivial
otherwise: keep the variable, rewrite the command, read the value out. Redaction
does not stop that; ownership does. Supplying your own value is always allowed
and makes you the new owner.

This mirrors how GitHub accounts already work here: credentials are personal per
profile, and sharing is something you opt into.

### Why the command text is the wrong place for either

```
$ sh -c 'NPM_TOKEN=npm_realtokenhere pnpm publish && npm trust ...'
$ ps -ww -eo pid,command | grep npm_
79902 sh -c NPM_TOKEN=npm_realtokenhere pnpm publish && npm trust ...
```

Any compound command keeps the shell alive, and its whole argv is readable by
`ps` for every process running as the same user. A single simple command happens
to escape this, because `sh -c 'VAR=x cmd'` replaces itself with `cmd`; that is
an accident of the shell, not a rule to rely on.

### What is redacted

Before output is persisted or broadcast, every hidden value is replaced with
`***`, and known credential shapes (`ghp_…`, `npm_…`, `//user:pass@`) are
stripped on top. The audit entry records the hidden variables' *names*, the
command, the exit code and who started it. Never a value.

## 2. Running a step that executes commands

Two independent gates, both required, neither implying the other:

1. **The instance switch.** *Allow executable pipeline steps* on module-code,
   off by default. An instance that never turns it on cannot be reached through
   this path at all.
2. **Two permissions, split by act.** `pipelines:execute` lets you RUN a
   pipeline containing command-running steps; `admin` and `maintainer` both hold
   it. `pipelines:author-execute` lets you CREATE or EDIT one, and only `admin`
   holds it.

   The asymmetry is the point, and it is the same one a CI system makes: who may
   edit the workflow file is held far tighter than who may re-run a job.
   Authoring decides what code the daemon executes; running is a routine act on
   something already reviewed. Import counts as authoring, because otherwise
   pasting a document would be a way around the restriction.

Two further rules are structural rather than configurable:

- **Webhook auto-runs never execute.** A pipeline started by a GitHub delivery
  passes "may not execute" unconditionally, so a push cannot reach a shell no
  matter how the pipeline is flagged.
- **Command steps run only in the daemon's container sandbox.** A remote runner
  refuses them because the current runner protocol cannot attest an equivalent
  isolation policy. It never falls back to executing as the daemon user.

### Sandbox contract

Turning the instance switch on is not sufficient. Configure a pre-pulled OCI
image pinned by digest under **Settings → Modules → Code**:

```text
ghcr.io/acme/companion-pipeline-node24@sha256:<64 hex characters>
```

At run time Companion calls Docker with `--pull never`, a read-only root,
non-root host uid/gid, all capabilities dropped, `no-new-privileges`, bounded
PIDs/CPU/memory, a bounded `/tmp`, and only the selected checkout mounted
read-write at `/workspace`. The daemon's environment is not inherited. Hidden
values are named with Docker `--env NAME` and supplied only to the Docker client
process environment, never embedded in its argv.

The default network is `none`. A publish pipeline needs an operator-created
network whose gateway enforces the exact registry/DNS egress policy you intend;
`host`, Docker's default `bridge`, and `default` are refused. Naming a custom
network does not make it restricted by itself. The Docker daemon/socket is a
privileged boundary, so expose it only to the Companion execution host or a
dedicated worker and pre-pull/verify the image there.

If Docker, the digest-pinned image, or that policy is unavailable, executable
and `npm-bootstrap` steps fail closed. Keep the feature disabled for repositories
or contributors you do not trust, and issue the narrowest short-lived publishing
credential the registry supports.

---

## 3. Passing values between steps

A step can export named outputs, and later steps interpolate them:

```
{{steps.<step name>.outputs.<key>}}
```

alongside the existing `{{pr.number}}`, `{{pr.title}}`, `{{pr.author}}` and
`{{repo}}`. What the built-in kinds export:

| Kind | Outputs |
|---|---|
| `checks-gate` | `state`, `passed`, `failed`, `pending` |
| `ai-review` | `risk`, `recommendation` |
| `slop-check` | `aiLikelihood`, `confidence` |
| `agent` | `pass` |
| `pr-state-gate` | `state`, `mergeable`, `headSha` |
| `merge` | `merged`, `method` |
| `npm-bootstrap` | `count`, `packages` |
| `executable` | whatever its `capture` patterns matched |

An `executable` step captures its own:

```jsonc
"capture": [
  { "name": "version", "pattern": "^v?(\\d+\\.\\d+\\.\\d+)$" }
]
```

The first capture group becomes the value, or the whole match when the pattern
has no group. A pattern that matches nothing produces no key at all, rather than
an empty string that would read downstream as a real answer.

**An unresolved placeholder is left as written.** `{{steps.Typo.outputs.x}}`
survives into the posted comment verbatim. That is deliberate: a visible wrong
placeholder is a bug report, a silently blanked one is not.

Outputs are persisted with the run and visible in its history, so **an output
must never carry a secret**.

---

## 4. Export and import

**Export** is on each pipeline card. It downloads a JSON document. Library
step references are resolved to inline steps on the way out, because a
step-definition id means nothing on another instance; an export that carried
them would import as a pipeline of dangling references. Exporting a pipeline
whose references no longer resolve fails rather than producing a document with
steps missing.

**Import** is in the page header and runs in two phases. The first parses the
document and shows what it would create, including a list of every step that
runs commands, with its command text and the hidden variables it expects. Nothing is
written at that point. The second phase creates the pipeline, and requires an
explicit acknowledgement when the list was non-empty.

Executable steps do **not** block an import. Creating a definition is not
running one, and running one is already gated by §2. The preview exists so you
read the commands, not to stop you.

An imported pipeline carries no hidden **values**, only variable names. The
preview lists them; open the step after importing and fill each one in before the
first run. A hidden variable with no value fails its step with
`hidden variable has no value: NAME` rather than running the command
unauthenticated.

---

## 5. Writing a document by hand

The envelope:

```jsonc
{
  "version": 1,
  "pipeline": {
    "type": "pr",              // "pr" | "issue" | "platform"
    "name": "Land new package",
    "description": "",
    "autoRunOnPrOpen": false,
    "steps": [ /* 1 to 30 steps */ ]
  }
}
```

Every step has `kind`, `name` (1 to 80 chars, and it is what `{{steps.…}}`
references), `onFailure` (`"halt"` or `"continue"`), and a `config` whose shape
depends on the kind. A worked example:

```jsonc
{
  "kind": "executable",
  "name": "Regenerate inventories",
  "onFailure": "halt",
  "config": {
    "command": "pnpm packages:inventory && pnpm bindings:status",
    "workdir": "pr-worktree",        // or "clone"
    "timeoutMs": 900000,             // 1s to 1h
    "variables": [
      { "name": "REGISTRY", "hidden": false, "value": "https://registry.npmjs.org" },
      { "name": "NPM_TOKEN", "hidden": true }   // value supplied in the editor, never in the file
    ],
    "capture": [],                   // optional
    "allowExitCodes": []             // optional; empty means only 0 passes
  }
}
```

Three things reject a document at import:

- a step kind the pipeline's type does not allow (`PIPELINE_TYPE_STEPS` in
  `modules/code/src/contract/pipelines.ts` is the list),
- a credential-shaped literal inside a `command` or a visible variable,
- for `npm-bootstrap`, a `workflowFile` that is a path rather than a bare
  filename: npm's trusted-publisher identity includes that filename, which is
  why the workflow file must never move or be renamed.

The authoritative shapes are the zod schemas in
`modules/code/src/api/pipelines.ts` (`pipelineStepSchema`,
`pipelineExportSchema`). The editor writes the same JSON, so the fastest way to
get a valid document is to build the pipeline in the UI once and export it.

### Checking a document before you import it

Two mistakes the schema cannot catch, both worth checking by eye:

- `{{steps.<name>…}}` referring to a step name that does not exist, or to a key
  that kind does not export (§3). It will not fail; it will post the literal
  placeholder.
- For `npm-bootstrap`, patterns scoped too widely. `packagePattern` runs only
  inside the section `sectionPattern` selects. Without that scoping it also
  matches the already-published list, and the step's count cross-check then
  refuses to publish, which is the safe outcome but not the one you wanted.
