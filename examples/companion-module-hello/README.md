# companion-module-hello

A minimal out-of-tree module for [Companion](https://github.com/moxxy-ai/companion).
It declares one permission (`hello:greet`), runs one migration (the
`hello_greetings` table), serves one authenticated route
(`POST /api/hello/greetings`) and renders one page at `#/hello`. It exists to be
read, copied, and installed into a running daemon as a working reference for the
[external module guide](https://github.com/moxxy-ai/companion/blob/main/docs/external-modules.md).

## Layout

```
src/module.ts        the manifest: pure data, imported eagerly at boot
src/contract/       the registry augmentation and shared DTOs
src/api/            acl, migrations, store, routes: the server slice
src/client/         nav, routes, page: the browser slice
build.mjs           esbuild, with the ABI marked external
```

The module depends on exactly two packages, both as devDependencies plus
peerDependencies and never as runtime dependencies: `@moxxy/companion-sdk` (the
authoring surface) and `@moxxy/companion-contracts` (the one specifier registry
augmentation must target). The build marks both external, so at load time every
import resolves to the host's single copy.

## Build and check

```sh
npm install
npm run build            # emits dist/module.js, dist/api.js, dist/client.js
companion module verify .    # static ABI check, no daemon needed
```

## Install into a Companion instance

```sh
companion module add companion-module-hello   # or: companion module add .
# restart Companion so it rescans the modules directory
companion module install hello
```

The page appears in the tool catalog for any signed-in role, and the route
answers under the `hello:greet` permission.

## Start your own module from this one

```sh
companion module scaffold my-module
```

copies this package with the name, module id and title substituted.
