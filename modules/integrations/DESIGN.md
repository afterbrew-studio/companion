# Integrations architecture

An integration is not a vendor-specific settings form. It is a provider module
that contributes one or more typed capabilities to a stable platform seam.

## Four planes

1. **Connection plane** — instance/workspace credentials, non-secret config,
   health and ownership. `module-integrations` owns this shared metadata and
   routes every secret through `ctx.secrets`.
2. **Execution plane** — a provider adapter executes a typed capability. A
   CodeRabbit adapter reviews a checkout; a Jira Automation adapter delivers an
   event. Callers never spawn a vendor command or shape a vendor payload.
3. **Domain-data plane** — vendor objects stay with their owner. Jira links and
   cached ticket snapshots belong to `module-jira`, review drafts stay in
   `module-code`, notification delivery history stays in `module-notify`.
4. **Presentation plane** — the generic Integrations page renders descriptors
   and declarative connection fields. Rich modules inject panels and actions
   through slots; work-item pages expose a provider-neutral external-links slot.

## Invariants

- Provider ids are namespaced (`vendor.protocol`), stable and owned by exactly
  one enabled module.
- A provider is a concrete protocol, not a logo. `jira.cloud` and
  `jira.automation` therefore have different schemas and behaviour.
- Secret fields are write-only. The client receives only the field names that
  are configured; values never cross the daemon boundary.
- Declarative fields validate shape; the owning adapter may also validate
  vendor semantics before any plain value or secret is persisted. Network and
  authentication checks remain an explicit health probe, so saving does not
  depend on the vendor being online.
- Connection scope and route scope are separate. A workspace connection may be
  selected only for one repository without duplicating its credentials.
- Select-one capabilities use ordered routes and explicit fallback. Fan-out
  capabilities (notifications) use every matching enabled connection.
- Disabling a provider unregisters its executable adapter but preserves its
  connections. Re-enabling it makes them usable again without re-entering
  credentials.
- A delegated review (for example Cursor Bugbot) is not treated as a quality
  gate verdict. Pipelines that require a verdict fail visibly instead of
  interpreting “request accepted” as “code approved”.
- Provider commands are predefined argument arrays, never user-authored shell.
  Local CLI adapters run without a shell, with an allowlisted environment,
  bounded output, time and abort.

## Extension surface

An out-of-tree Companion module depends on `integrations`, then registers an
`IntegrationProviderAdapter` in `onEnable` and unregisters it in `onDisable`.
The adapter types and `IntegrationUnavailableError` come from the allowed,
public `@moxxy/companion-sdk/server` ABI; no private in-tree package is needed
at runtime. Resolve the optional host service with `ctx.services.tryGet()` as
required for every out-of-tree cross-module boundary.

```ts
import type { IntegrationProviderRegistry } from '@moxxy/companion-sdk/server';

declare module '@moxxy/companion-contracts' {
  interface ServiceMap { integrations: IntegrationProviderRegistry }
}

// onEnable: const registry = ctx.services.tryGet('integrations');
//            unregister = registry?.registerProvider(myProvider) ?? null;
```

A rich module that also owns vendor actions can declare the broader
`IntegrationHost` instead. Its authenticated server route calls
`resolveTargets(capability, scope, explicitConnection, userId)` to obtain only a
connection valid for that operation's scope and owner. This is the supported
path to write-only credentials; external modules never read integration tables
or the host secret store.

Most providers need no client code: their descriptor drives the catalog and
connection form. A richer provider may contribute to:

- `integrations.page.actions`
- `integrations.provider.<provider-id>.panel`
- `integrations.provider.<provider-id>.form`
- `integrations.connection.<provider-id>.actions`
- `integrations.repository.sections`
- `work-item.links`

The provider module owns any additional routes, tables and components behind
those contributions. The central catalog never accepts arbitrary vendor JSON
as domain state.
