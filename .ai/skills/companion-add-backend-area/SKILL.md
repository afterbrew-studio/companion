---
name: companion-add-backend-area
description: >-
  SUPERSEDED redirect. Adding a backend "area" is now building the api slice of a
  module in the modular framework. Use companion-build-module and modules/README.md.
---

# Add a backend area → build a module's api slice

Companion is now a **modular framework**. The old layered spine this recipe
described — `packages/contract`, `apps/companiond`, `store/db.ts`, `ApiDeps`,
`buildRoutes`, the composition root in `index.ts` — **no longer exists**. A
"backend area" is the **`src/api` slice of a module** under `modules/*`.

Use **`companion-build-module`** and **`modules/README.md`** (the complete
authoring guide). Concept mapping:

| Old (layered daemon) | New (module api slice) |
|---|---|
| DTO/permission/WS type in `packages/contract` | `modules/<id>/src/contract/index.ts` — DTOs + `declare module` augmenting `PermissionRegistry` / `ServerMessageRegistry` / `ServiceMap` |
| `store/<x>.ts` + wire in `store/db.ts` | `src/api/<x>-store.ts` (module owns its tables) + `src/api/migrations.ts` (`defineMigrations`, versioned, with `down()`) |
| service class + inject via `ApiDeps` | `src/api/<x>-service.ts` + `src/api/services.ts` (`defineServices` → `ctx.services.register('<id>', svc)`); deps via `ctx.services.get(dep)` |
| `http/routes/<x>.ts` + line in `buildRoutes` | `src/api/routes.ts` (`defineRoutes` → `route({ access })`); no central registry |
| composition root wiring | `src/api/index.ts` (`defineApiModule({...})`) + one entry in `apps/api/src/modules.ts` |
| webhook special-case in the server | `src/api/raw-routes.ts` (`defineRawRoutes`/`rawRoute`) |

Still true (see `companion-code-standards`, `companion-store-and-migrations`,
`companion-contract-and-rbac`): relative imports end in `.js`; DTOs are
`readonly`; migrations are additive & idempotent; RBAC is declared once and
enforced centrally by the router; every mutation `ctx.broadcast`s its
`'<id>.changed'`.
