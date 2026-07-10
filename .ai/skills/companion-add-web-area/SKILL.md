---
name: companion-add-web-area
description: >-
  SUPERSEDED redirect. Adding a web "area" is now building the client slice of a
  module in the modular framework. Use companion-build-module and modules/README.md.
---

# Add a web area → build a module's client slice

Companion is now a **modular framework**. The old SPA spine this recipe described
— a central `lib/api.ts`, `modules.tsx` nav registry, and the `App.tsx Route()`
if-ladder — **no longer exists**. UI for a domain is the **`src/client` slice of
a module** under `modules/*`; the shell (`apps/web`) only hosts modules via
`ModulesProvider`/`useKernel` and presents their contributions.

Use **`companion-build-module`** and **`modules/README.md`** (the complete
authoring guide). Concept mapping:

| Old (central SPA) | New (module client slice) |
|---|---|
| method on `lib/api.ts` | `src/client/api.ts` — a per-module slice using `request`/`post` from `@companion/core/client` |
| `hooks/use<X>.ts` | `src/client/hooks/use<X>.ts` — `useLive(refresh, msg.t === '<id>.changed')` (single shared socket) |
| `pages/<X>.tsx` | `src/client/pages/<X>.tsx` — lazy-loaded via `lazyView`/`page` (own Vite chunk) |
| entry in `modules.tsx` | `src/client/nav.tsx` — `defineNav`/`defineSections` (+ `NavIcon` for the icon) |
| branch in `App.tsx Route()` | `src/client/routes.tsx` — `defineClientRoutes` (whole-segment match, no ordering hazard) |
| — | `src/client/index.tsx` — `defineClientModule({...})` + one entry in `apps/web/src/modules.ts` |

Extension points: `defineSlots` renders your component INTO another module's page
(inversion of control); `defineOnboarding` contributes a welcome-tour step gated
on your own permission. The client barrel must `import '../contract/index.js'`
**first**. Reuse `@companion/ui` — don't hand-roll a modal or router. RBAC is the
same `Permission` on nav + route; the shell filters by the live `can()`.
