# External modules

A Companion module does not have to live in the Companion repository. An
external (out-of-tree) module is an npm package that a running daemon loads
from `$COMPANION_HOME/modules/<id>/`: a private enterprise module, a
customer-specific module, or a third-party plugin. It has the whole module
surface available: routes, services, migrations, permissions, background jobs
and config on the server, plus nav entries and pages in the browser.

Before writing one, consider the cheaper option. A module in the Companion
repository under `modules/*` is compiled with the host, gets full type safety
across the open registries for free, and can be kept out of an artifact with a
[build profile](development.md#build-profiles-what-ships). Reach for an
external module only when the code genuinely cannot be compiled in: it is
private, it belongs to someone else, or it must install without a redeploy.

Day-to-day operation (add, install, enable, remove) is covered in
[operating modules](operating-modules.md). This page is about writing one.

## Start from the template

```sh
companion module scaffold my-module
cd companion-module-my-module
npm install
npm run build
companion module verify .
```

`scaffold` copies
[`examples/companion-module-hello`](../examples/companion-module-hello), a
minimal published module (one permission, one migration, one authenticated
route, one page), with the package name, module id and title substituted. The
same package is on npm as
[`companion-module-hello`](https://www.npmjs.com/package/companion-module-hello),
so you can also install it into an instance to see the end state first:

```sh
companion module add companion-module-hello
# restart Companion, then:
companion module install hello
```

## The ABI is two packages

```
@moxxy/companion-sdk        everything you import
  .          defineManifest, manifest and config types, SDK_VERSION, ABI_GENERATION
  /server    defineApiModule, defineAcl, defineMigrations, defineRoutes, route(),
             Reply helpers, HttpError helpers, ModuleContext, Migration
  /client    defineClientModule, defineNav, defineClientRoutes, defineSlots,
             lazyView, page, useLive, request/post/put/patch/del, NavIcon
  /ui        the presentational kit, so a module page looks native
  /agents    agent-run types, for modules that compose runs

@moxxy/companion-contracts  one line: the registry augmentation target
```

The second package is not an oversight. TypeScript binds declaration merging to
the package that declares an interface. Augmenting a package that merely
re-exports it creates a second, unrelated interface, and your permission is
silently absent from `Permission`. So the open registries are imported from and
augmented on the same package, and the SDK deliberately does not re-export
them:

```ts
declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry {
    'my-module:read': true;
  }
}
```

Declare both packages as devDependencies plus peerDependencies, never as
runtime dependencies: an installed copy of the SDK inside the module is the
failure mode, not a fix (see below).

The surface is pinned in `packages/sdk/surface.json` and CI fails on drift.
Anything not in it is host machinery and is unreachable on purpose.

## The moxxy block and install layout

Publish built output only. `package.json` carries a `moxxy` block, read as data
before anything is imported:

```json
{
  "name": "companion-module-my-module",
  "version": "1.0.0",
  "type": "module",
  "moxxy": {
    "id": "my-module",
    "abi": "0.x",
    "manifest": "./dist/module.js",
    "api": "./dist/api.js",
    "client": "./dist/client.js"
  }
}
```

`moxxy.id` must equal the directory the module installs into, so one module
cannot shadow another. `abi` is a generation, not a semver range: while the SDK
is pre-1.0 every minor may break, and a caret range would let an old module
load into a new daemon and fail somewhere deep instead of at boot. Omit
`client` for a server-only module.

Installed, a module is a directory containing `package.json` and `dist/`, with
no `node_modules`. `companion module add <spec>` puts it there, records
provenance (spec, resolved version, integrity hash, registry), and runs the
same static checks as `verify` while the files are still staged. The daemon
scans the directory once, at boot, so files being in place is not the same as
the daemon knowing about them: restart, then `companion module install <id>`.

## What a built module may import

The built entry chunks may statically import only:

- server (`dist/api.js`): `@moxxy/companion-sdk`, `/server`, `/agents`, `zod`,
  `ws`, and `node:` builtins
- client (`dist/client.js`): `@moxxy/companion-sdk`, `/client`, `/ui`, `react`,
  `react/jsx-runtime`, `react-dom`

Everything else must be bundled into the module's own artifact. A database
driver is deliberately not on the list: a module receives the host's handle as
`ctx.db`, and opening its own connection would sit outside the daemon's WAL and
transaction discipline.

The build marks the allowed specifiers external, so they resolve to the host's
single copy at load time:

```js
// esbuild
external: ['@moxxy/companion-sdk', '@moxxy/companion-sdk/*', 'zod', 'ws']  // server
external: ['@moxxy/companion-sdk', '@moxxy/companion-sdk/client', '@moxxy/companion-sdk/ui',
           'react', 'react/jsx-runtime', 'react-dom']                      // client
```

Build the client chunk for production. The host serves no
`react/jsx-dev-runtime`, so a development build fails to resolve instead of
dragging React's development runtime into a production page.

Everything else about the module is written exactly like an in-tree one: the
same `define*` registrants, the same `ModuleContext`, the same migrations, ACL
and broadcast discipline. [Writing a module](../modules/README.md) remains the
authoring reference; only compilation and delivery differ.

## Verify before anything else runs it

```sh
companion module verify ./my-module
```

`verify` runs against files, with no daemon: it checks the `moxxy` block, the
ABI generation, that the entry files exist, that the built chunks' static
imports stay inside the allowlist above, and that no ABI package is vendored or
listed as a runtime dependency. Run it in the module's own CI.

The check exists because the failure it prevents is silent. A module that ships
its own copy of the SDK gets its own `Reply` class; the router decides what to
send with `result instanceof Reply`, so `redirect('/board')` comes back as HTTP
200 with a JSON body and nothing in the log. On the client the equivalent is a
second React instance: hooks throw, and context resolves to defaults without an
error. The daemon refuses both at scan time; `verify` catches them before
publish.

How the single copies are guaranteed, briefly: on the server the daemon writes
a small bridge package into `$COMPANION_HOME/modules/node_modules` at every
boot that re-exports its own live SDK namespace, and Node's ordinary upward
resolution finds it from any module directory. In the browser the app emits an
import map that resolves the six client specifiers to `/host/*.js`, entry
points of the same build as the app, so a module chunk shares the host's React.
A chunk that cannot resolve them fails loudly and drops only itself.

## What the type system stops guaranteeing

The open registries (`PermissionRegistry`, `ServerMessageRegistry`,
`ServiceMap`, bus events) are declaration merges that close over one
compilation. An external module augments them in its own compilation and gets
full safety for its own ids; the host never sees them. Consequences:

- Use `ctx.services.tryGet(...)` across every boundary into the host or
  another module, never `get`. The host may be a version without that service.
- Never assume a permission or service exists because its type resolved.
- Check the host version at load time and refuse to enable with a clear
  message rather than failing halfway through `onEnable`.
- Make migrations additive and idempotent, with a `down()` (or `purge()`), so
  `remove` leaves the database clean.
- Release in `onDisable` everything `onEnable` claimed.

## Trust, stated plainly

External modules run in-process, with the database handle, the service registry
and full filesystem access. There is no sandbox. Treat adding a module like
adding a dependency to a production service: review what you install, pin
versions, and prefer sources you control. The provenance record written by
`companion module add` exists so that an instance can always answer what is
installed and where it came from.
