# Today, AI Help, and MCP

Companion has one default operating loop:

1. Open **Today** to see only work that has stopped for a human decision.
2. Ask **AI Help** to find context, compare evidence, or draft requirements and
   documentation in plain language.
3. If the request changes state, review the exact approval card and confirm it.
4. Return to Today. The owning area remains the source of truth and updates the
   queue live.

The same model is available to IDE agents through MCP. There is no second set
of automation semantics hidden in the integration.

## The everyday interface

The sidebar is organized around outcomes rather than technical modules:

- **Home** contains Today, Overview, and Daily Digest;
- **Workspace** contains repositories and workspace automation policy;
- **Plan & build** contains ideas, specifications, documentation, refinement,
  and the task board;
- **Code & review** contains issues, pull requests, pipelines, and contribution
  quality;
- **Agents** contains activity, the queue, and agent-quality reporting;
- global **Search** (`⌘K`) reaches every permitted destination and the bounded
  laboratory/drill-down catalog without replacing those primary groups;
- **Settings** has one stable entry outside those work groups.

The **Menu view** preference under **Your profile → Navigation** offers
**Automatic**, **Business**, **Developer**, and **Admin**. Automatic derives a
useful default from the user's live capabilities, including custom roles.
Business keeps shared context and planning in the sidebar, Developer keeps code
delivery and agent operations, and Admin includes every permitted group. The
view changes navigation only, never RBAC: filtered pages remain reachable from
Search and direct links. Page switches below the selector mirror the active
preset and can add or remove pages from that view; those customisations and
manual fold choices are remembered independently per view.

The authored defaults are deliberately concrete (an item appears only when its
module is enabled and RBAC also permits it):

| View | Default sidebar work areas |
| --- | --- |
| Business | Today, Repositories, Ideas, Specifications, Documentation, Task Board |
| Developer | Today, Overview, Daily Digest, Repositories, Automations, Specifications, Documentation, Refinement, Task Board, Code & review, Agents |
| Admin | Every permitted primary page from all five work areas |

Enabled modules contribute actions to the global **New** menu and pages to
command search, so installing a module does not require adding another permanent
menu. Missing prerequisites are handled where they matter: an empty page offers
one next action such as **Create workspace** or **Connect repository**.
Companion does not automatically open a product tour; the optional tour remains
available from shortcut help (`?`).

```text
AI Help / MCP ── GET ───────────────► existing domain APIs
      │
      └── prepare typed action ─────► pending approval card
                                            │ human browser session
                                            ▼
                                      owning domain service
                                      (GitHub / run / Board / Plan)
                                            │
                                            └── live update ──► Today + AI Help
```

## What Today collects

Today composes decisions already owned by the rest of Companion. It does not
copy their state or invent another lifecycle:

- reviewed agent changes waiting to publish or discard;
- pending pull-request review evidence;
- pending issue triage;
- Board failures and manual merge gates;
- action proposals prepared by AI Help, MCP, or the SPA.

Blocked work is first, then the oldest decision. Active Board work suppresses
duplicate run/review rows, while a pending review is shown before its merge
gate. The response is bounded to 200 decisions.

The default Today view presents a compact, ordered decision list using the same
row pattern as the rest of Companion. The named primary action opens the owning
surface, **Snooze 4h** removes the row from the personal queue temporarily, and
**Do next** puts it in a small local focus list. Snooze and focus are private
browser organization only: they do not change the authoritative issue, pull
request, run, or approval state. Prepared actions remain explicit approval
cards above the list because they can cause a real mutation.

## AI Help

AI Help is the global drawer in the top bar. It can read the REST API under the
current user's live role, workspace membership, and GitHub account access. A
repository selector narrows the conversation without granting access to a new
repository.

The credential inside its isolated agent run is structurally read-only. The
central router rejects every non-GET request except two narrow operations:

- prepare a typed Workbench action;
- navigate or open a form in that same user's browser.

Prompt instructions are therefore not the security boundary. Even a confused
or prompt-injected model cannot call a direct GitHub, run, Board, specification,
or documentation mutation through that credential.

Useful requests include:

- “What actually needs me today? Summarize the evidence and highest risk.”
- “Draft a complete specification for repository `acme/app` from the existing
  docs and open issues, then give me one approval card.”
- “Compare the pending PR review with CI and prepare publication if it is still
  current.”
- “Turn this explanation into searchable workspace documentation.”

## Prepared actions

Preparation resolves the authoritative target, snapshots its version, stores a
30-minute single-use proposal, and shows the exact summary and consequence.
Content proposals also render the complete Markdown. Execution:

- is unavailable to delegated AI Help sessions;
- requires every domain permission declared by that action;
- re-resolves the target and refuses stale proposals;
- atomically claims the proposal before calling the owning service;
- records success or failure and never retries an interrupted external write.

The initial catalog covers:

| Area | Prepared outcomes |
|---|---|
| Agent changes | publish, discard |
| Pull-request reviews | publish, dismiss |
| Issue triage | apply, dismiss |
| Board | merge, retry failed work |
| Planning content | create a virtual specification or documentation entry |

## MCP server

Start the newline-delimited JSON-RPC stdio server with:

```sh
companion mcp
```

It uses the local daemon address and the owner-only token in
`$COMPANION_HOME/cli-token`. A typical MCP client entry is:

```json
{
  "mcpServers": {
    "companion": {
      "command": "companion",
      "args": ["mcp"],
      "env": {
        "COMPANION_HOME": "/absolute/path/to/.companion"
      }
    }
  }
}
```

For a remote daemon, pass secrets through the process environment, never CLI
arguments:

```text
COMPANION_URL=https://companion.example.com
COMPANION_TOKEN=<existing Companion bearer token>
```

The MCP surface contains:

- `companion_today` for the decision queue;
- `companion_get` for bounded GET access below `/api/`;
- `companion_list_prepared_actions` for proposal status;
- one `companion_prepare_*` tool per server-side action definition.

The catalog is filtered through the connected user's current role and enabled
modules. An IDE therefore sees only the preparation tools that can actually be
used on that instance; a custom read-only role does not get a menu full of
actions that will end in `403`.

Tool schemas are generated from `/api/workbench/actions/catalog`, so adding an
argument or action does not require a separate MCP schema. There is deliberately
no execute tool. A model can prepare work; the ordinary browser session owns the
final click.

The stdio server is dual-era. Current clients can use the stateless MCP
`2026-07-28` flow (`server/discover` plus version and capabilities in every
request's `_meta`); existing clients can still use the `2025-11-25` and earlier
initialization-based revisions. Tool results provide both structured content
and a JSON text fallback, and responses over 256k characters are refused so an
accidental broad query does not consume the model's context.

### Practical MCP workflows

The most useful pattern is **read → narrow → prepare → review in Companion**:

1. Ask “What needs me in workspace X?” The client calls `companion_today` and
   summarizes blocked work before older review items.
2. Ask for evidence on one item. The client uses a narrow `companion_get`, for
   example an individual pull request, issue, run, or documentation search.
3. Ask it to prepare the smallest outcome: publish a reviewed result, retry a
   failed Board task, or save complete Markdown as a specification/document.
4. Inspect the exact card in **Today** or **AI Help** and click **Confirm and
   apply**. Preparation alone never means the operation happened.
5. In a later IDE turn, ask for the result. The client reads
   `companion_list_prepared_actions` and the owning target; only a `completed`
   proposal plus matching target state is reported as success.

This supports daily triage, review summaries, requirements drafted from current
repository evidence, searchable runbooks, and hand-off from an IDE conversation
to a controlled platform action. It intentionally does not support silent
merge, publish, deletion, or agent execution from MCP. Those remain ordinary
Companion actions with a visible human confirmation boundary.
