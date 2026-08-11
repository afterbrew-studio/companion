# Operating modules

Which modules a build *contains* is a
[build profile](development.md#build-profiles-what-ships). Which of those are
*running* is runtime state, and this is how you change it.

## The CLI

From the **Modules** admin page, or against a running daemon:

```sh
companion module list                     # every module in this build and its state
companion module info slop                # dependencies, permissions, config spec
companion module install slop --set label=ai-slop
companion module enable slop
companion module disable slop             # stops it, keeps its tables and config
companion module uninstall slop           # rolls back its migrations, wipes its config
companion module config slop --set label=junk
```

`install` also enables, and is idempotent: run it on a module that is already on
and it applies any `--set` config and returns. `disable` is reversible;
`uninstall` is not, and asks before running (`--yes` in scripts). Installing runs
the module's migrations; uninstalling rolls them back to zero and clears the
ledger, so a later re-install starts clean.

The CLI authenticates with a token the daemon mints at boot into
`$COMPANION_HOME/cli-token` (mode 0600). It is an admin-equivalent credential;
the directory already holds the database, so it does not widen that blast radius.

## Turning on everything a `full` build contains

A `full` build is not a full instance. Every optional module declares
`autoInstall: false`, so straight after a deploy the running surface is identical
to `slim`. The difference is what you can turn on without rebuilding.

First confirm the build actually contains them, because a missed build argument
looks exactly like a module that refuses to install:

```sh
companion module list        # expect 20 modules, 14 enabled (not "14 of 14")
```

`Unknown module: plan` means the module is not in this build at all, so no amount
of installing will help. Rebuild with the right profile.

Then adopt them. The order satisfies `dependsOn` (`refinement` and `planner` need
`plan` and `board`), and the kernel refuses an out-of-order install rather than
half-enabling anything:

```sh
for m in plan board refinement planner automations slop playground; do
  companion module install "$m"
done
```

`oidc` is deliberately not in that list. It needs its provider configured first,
and `COMPANION_PUBLIC_URL` set to the address the provider redirects back to:

```sh
companion module install oidc \
  --set issuer=https://example.okta.com \
  --set clientId=... --set clientSecret=...
```

In Docker, run these inside the container (`docker exec -it <container> sh`),
where the CLI finds the daemon and its token in `/data`.

## Out-of-tree modules

A module does not have to live in this repository.
[`@moxxy/companion-sdk`](https://www.npmjs.com/package/@moxxy/companion-sdk) is
the published authoring surface, and a daemon loads anything installed into
`$COMPANION_HOME/modules/<id>/`.

This covers the whole module surface: routes, services, migrations, permissions,
background jobs and config, plus nav entries and pages. The browser side works
through an import map the app emits, so a module chunk shares the host's React
and SDK instead of bundling its own.

### Installing one

```sh
companion module add companion-module-hello   # fetch, check, record
# restart Companion so it rescans the modules directory
companion module install hello && companion module enable hello
```

`companion-module-hello` is a real published example, maintained in this
repository under [`examples/companion-module-hello`](../examples/companion-module-hello)
and released alongside the SDK, so the commands above work against any registry
mirror that carries it.

`add` needs no running daemon. npm resolves the spec, so a scope, a tag, a
version range, a private registry and its credentials all work. It records what
it installed in `$COMPANION_HOME/modules/.provenance.json`: the spec as typed,
the resolved name and version, the integrity hash and the registry. Replacing a
module that is already there needs `--force`, and deletes first, because a merge
would leave a file the new version dropped in place and still importable.

`add` installs no dependencies, and that is a decision. `verify` already requires
a module's entry chunks to import the ABI and nothing else, so a publishable
module has bundled its libraries. The one thing an install could add is the thing
the ABI cannot survive: a second copy of the SDK inside the module.

### Authoring one

```sh
companion module scaffold my-module   # generates ./companion-module-my-module
```

`scaffold` copies the hello-world example with the package name, module id and
title substituted, ready for `npm install`, `npm run build` and
`companion module verify .`. It needs no daemon; the template ships inside the
CLI package.

An out-of-tree module depends on exactly two packages:

```jsonc
{
  "devDependencies": { "@moxxy/companion-sdk": "^0.8.2", "@moxxy/companion-contracts": "^0.6.1" },
  "peerDependencies": { "@moxxy/companion-sdk": "^0.8.2" },
  "moxxy": {
    "id": "hello",           // must equal the install directory name
    "abi": "0.x",            // the ABI generation, checked at boot
    "manifest": "./dist/module.js",
    "api": "./dist/api.js"
  }
}
```

Everything is imported from the SDK except one line: registry augmentation must
target `@moxxy/companion-contracts`, because TypeScript binds declaration merging
to the package that declares the interface, and a façade would silently produce a
second, empty registry.

```ts
declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry { 'hello:read': true }
}
```

Build with the ABI marked external, publish `dist/` and `package.json` with **no
`node_modules`**, then check it before it goes anywhere near a daemon:

```sh
companion module verify ./dist-package     # static ABI check, no daemon needed
```

`verify` refuses a module that vendors an ABI package or imports outside the
allowlist, and the daemon refuses the same at boot, with the reason in its log,
while the other modules keep loading. That check exists because the failure is
silent otherwise: a second copy of the SDK means a second `Reply` class, and
`redirect()` starts returning HTTP 200 with a JSON body instead of a 302.

A module with a UI also declares `moxxy.client` and builds a browser chunk with
`react`, `react/jsx-runtime` and the SDK subpaths **external**, for production.
The app serves those six specifiers at stable `/host/*.js` URLs and maps them in
an import map, so the module gets the host's React rather than a second one. A
chunk that cannot resolve them fails loudly and drops only itself; the rest of
the shell keeps working.

The full authoring guide is [external modules](external-modules.md), and
`pnpm sdk:surface` prints the ABI and fails on a breaking change.
