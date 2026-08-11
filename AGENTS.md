# AGENTS.md: Companion

Universal entry point for any AI coding tool working in this repo. Most agent
tools (OpenAI Codex, Cursor, Amp, Jules, Aider, ...) read the nearest
`AGENTS.md` automatically; this root file is the shared, lab-neutral instruction
set. It **routes** to the deep knowledge base and to each frontier lab's native
config; it does not duplicate them.

## Where things live

- **`.ai/`**: the single source of truth: reusable **skills** (`.ai/skills/*`)
  and **agent role definitions** (`.ai/agents/*`). Edit knowledge here, nowhere
  else. Start at [`.ai/README.md`](.ai/README.md).
- **`.claude/`**: Anthropic (Claude Code) entry point; symlinks
  `skills/` + `agents/` to `../.ai/` so Claude Code auto-discovers them, and
  holds Claude-specific config (`settings.local.json`).
- **`.codex/`**: OpenAI (Codex) entry point; a thin reference back to this file
  and `.ai/`.

Other labs need no new directory: they read this `AGENTS.md` and can open any
`.ai/agents/*.md` as a role prompt and any `.ai/skills/*/SKILL.md` as guidance.

## Read the relevant skill before non-trivial work

The `.ai/skills/` are the authoritative, verified conventions. Load the one(s)
that fit the task first:

| Task | Skill |
| --- | --- |
| Orient / find where something lives | `companion-architecture` |
| Write or edit any TS/React here | `companion-code-standards`, `craft-principles` |
| Add a permission / DTO / WS event | `companion-contract-and-rbac` |
| Touch the database | `companion-store-and-migrations` |
| Build or extend a module | `companion-build-module`, [`modules/README.md`](modules/README.md) |
| A module outside this repo | `companion-external-module` |
| Profiles, editions, what ships | `companion-editions-and-distribution` |
| Launch / drive / react to an AI agent run | `companion-agent-runs` |
| Prompt an agent or parse model output | `agent-prompting-and-parsing` |
| Read/write GitHub | `companion-github-integration` |
| Add/change a pipeline step kind | `companion-pipelines` |
| Reason about cost, or review a change | `performance-and-complexity`, `critical-thinking` |
| Verify a change / secure a boundary | `companion-verification`, `companion-security` |

Specialised agent roles live in `.ai/agents/`: **module-builder** (scaffolds a
module end-to-end), **companion-reviewer** (diff review, ranked findings),
**codebase-navigator** (traces the spine, returns `file:line` maps). In Claude
Code invoke them as subagents; in other tools, use the file as the system prompt.

## The project in one paragraph

Companion is a self-hosted control plane that drives GitHub repos with AI
agents ([moxxy](https://github.com/moxxy-ai/moxxy), Claude Code, Codex, or the
built-in runtime). It's a pnpm monorepo, all ESM, strict TypeScript, built as a
**modular framework**: a small kernel loads feature modules that install,
enable, disable and uninstall at runtime.

- **`modules/*`**: the product domains. Each module is one vertical slice with
  four entry points: `src/module.ts` (manifest metafile), `src/contract/`
  (cross-boundary DTOs + registry augmentations), `src/api/` (acl, migrations,
  stores, services, routes, jobs; server only), `src/client/` (nav, routes,
  pages, hooks; browser only). See [`modules/README.md`](modules/README.md).
- **`apps/api`**: the daemon (SQLite + typed HTTP/WS); **`apps/web`**: the SPA
  shell (React + Vite + Tailwind) that hosts module clients. **`apps/companion-cli`**
  is the published npx CLI, **`apps/companion-runner`** the remote execution
  agent, **`apps/landing`** the static site.
- **`packages/`**: the framework: `types`, `contracts`
  (`@moxxy/companion-contracts`, the shared registries every module augments),
  `services`, `core` (the kernel), `sdk` (the published module ABI), `ui`
  (the design system), `runtime` (the built-in agent loop).
- **`profiles/*.json`** name which modules a build contains.

`moxxy` is an external CLI runtime invoked as a subprocess, never bundled.

## Load-bearing invariants (full detail in `companion-architecture`)

1. **RBAC is enforced once, centrally** in the router from each route's `access`;
   the SPA mirrors the same `Permission`. Never re-check or skip auth in a handler.
2. **Every cross-boundary type lives in the owning module's contract slice**,
   augmenting the registries in `@moxxy/companion-contracts`; never redefined.
3. **`issues`/`prs` are a cache** of GitHub; GitHub stays authoritative.
4. **Every state mutation broadcasts** its `*.changed` event; exactly one client
   hook consumes it.
5. **Migrations are additive and idempotent**; `down()` exists for module
   uninstall, not for rewriting shipped schema.
6. **Relative imports end in `.js`** (NodeNext); DTOs are `readonly`.
7. **Secrets never cross to the client**; unattended agent runs auto-allow but
   stay fenced (isolated cwd + deny rules + token ceiling + review-then-apply).

## Quality gate

There is no linter, but there is a real gate. Before calling a change done:

```sh
pnpm typecheck    # gen:modules + tsc across the workspace
pnpm test         # pnpm -r test: ~150 node:test suites (modules, packages, apps)
pnpm acl check    # the RBAC grid gate (also runs in CI)
pnpm sdk:surface  # the published module ABI; fails on a breaking change
```

CI runs all four. For behaviour or UI work, types and tests are still not
enough: drive the real flow in `pnpm dev` and observe it. Do not add
dependencies without justification; prefer the platform and the existing
`@moxxy/companion-ui` kit. See `companion-verification`.

## Commands

```sh
pnpm install      # corepack enable first; pnpm 10, Node >= 24
pnpm dev          # companion-api :8901 + Vite :5173 (proxies /api, /ws)
pnpm build        # generate the module registries, then build everything
pnpm typecheck    # generate, then type-check everything
```

Set `COMPANION_PROFILE=full` to work with every module; the default profile is
`slim`.

## Conventions this repo does NOT want

- Adding a package when the platform (`fetch`, `node:crypto`, `URLSearchParams`)
  or `@moxxy/companion-ui` already covers it.
- A router library, an ORM, a new auth check in a handler, a locally-redefined DTO.
- Committing with a `Co-Authored-By`/AI-attribution trailer (the maintainer is
  the sole author). Only commit or push when asked.
