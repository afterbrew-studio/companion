# @moxxy/companion-sdk

The module-authoring surface for [Companion](https://github.com/moxxy-ai/companion), a local-first control plane for software teams and AI agents.

A Companion module is an npm package that the daemon loads at boot. It can add pages to the sidebar, routes to the API, tables to the database, permissions to the role model, and jobs to the scheduler. This package is everything such a module is allowed to import.

```sh
npm install @moxxy/companion-sdk @moxxy/companion-contracts
```

## Entry points

| Import | For |
| --- | --- |
| `@moxxy/companion-sdk` | Manifest types, ids, shared primitives |
| `@moxxy/companion-sdk/server` | Routes, replies, stores, migrations, the service container |
| `@moxxy/companion-sdk/client` | React hooks for auth, workspace, the bus and live queries |
| `@moxxy/companion-sdk/ui` | The host's components, so a module looks native |
| `@moxxy/companion-sdk/agents` | Spawning agent runs and reading their output |

## Declaring what you add

Permissions, server messages, services and bus events live in open registries you extend with declaration merging. Augment `@moxxy/companion-contracts` directly, never the SDK: TypeScript binds a merged declaration to the module that declared the interface, so augmenting a re-export creates a second, unrelated interface and your keys never appear.

```ts
declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry {
    'reports:read': true;
    'reports:write': true;
  }
}
```

## The resolved-at-runtime rule

The SDK ships types, not implementations. At boot the daemon writes a bridge into `$COMPANION_HOME/modules/node_modules/@moxxy/companion-sdk` that re-exports the host's own live namespace, so `instanceof` works and there is exactly one router, one database handle and one event bus.

A module that vendors its own copy of the SDK is refused at scan time with a named reason, because a second copy silently breaks identity checks. Ship it as a dependency and let the host resolve it.

## Verifying a module before you publish

```sh
companion module verify ./my-module
```

This checks the ABI generation, the manifest shape, the entry paths, and that you import nothing outside this package. Companion also publishes `@moxxy/companion-core`, `-services`, `-types` and `-ui`; those exist so TypeScript can resolve these declarations, and importing them directly is what `verify` refuses.

## Documentation

Module system, worked examples and the full contract reference: [modules/README.md](https://github.com/moxxy-ai/companion/blob/main/modules/README.md).

## License

MIT
