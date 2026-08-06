# Configuration

Companion reads real environment variables first, then `./.env`, then
`~/.companion/.env` for local runs. In Docker, Compose passes variables from
`.env` and sets `COMPANION_HOME=/data`.

## Common variables

| Variable | Default | Description |
| --- | --- | --- |
| `COMPANION_HOST` | `127.0.0.1` | HTTP and WebSocket bind host. Docker Compose sets `0.0.0.0` for published ports. |
| `COMPANION_PORT` | `8901` | HTTP and WebSocket port. |
| `COMPANION_HOME` | `~/.companion` | Data directory: SQLite database, clones, worktrees, isolated moxxy home. |
| `COMPANION_PUBLIC_URL` | unset | The address SSO and webhooks come back to. Required behind a domain. |
| `COMPANION_ADMIN_USER` / `COMPANION_ADMIN_EMAIL` / `COMPANION_ADMIN_PASSWORD` | unset | Seed admin account. Read only while the user store is empty. |
| `COMPANION_MAINTAINER_USER` / `COMPANION_MAINTAINER_PASSWORD` | unset | Optional seed maintainer account. |
| `COMPANION_BUSINESS_USER` / `COMPANION_BUSINESS_PASSWORD` | unset | Optional seed business account. |

Seed accounts are imported once into an empty user store; after that the Users
page owns accounts. See
[`install.md`](install.md#the-first-admin-wizard-or-seeded-from-the-environment)
for what that means in practice.

`COMPANION_PROFILE` is **not** in this table on purpose. It is read when an
artifact is built, not when one runs. See
[`development.md`](development.md#build-profiles-what-ships).

## Daemon settings

Advanced settings such as `maxLiveRuns` and `moxxyCliPath` live in
`${COMPANION_HOME}/companiond.json`, written after first boot.

## MCP servers for the built-in runtime

External tools an agent run may call. Configure them under Settings → MCP
servers, or declare them in `companiond.json` so a container ships with its
integrations. Each server's one secret arrives by environment indirection and is
substituted wherever `${secret}` appears:

```json
{
  "mcpServers": [
    {
      "id": "inventory",
      "label": "Inventory",
      "transport": "http",
      "url": "https://mcp.acme.internal/mcp",
      "headers": { "authorization": "Bearer ${secret}" },
      "secretEnv": "INVENTORY_MCP_TOKEN",
      "access": ["workspace-write"],
      "tools": ["lookup"]
    }
  ]
}
```

`access` is the run accesses this server serves, and a run whose access is not
listed is never offered its tools. `tools` is an allowlist; omit it to offer
everything the server lists. `transport: "stdio"` takes `command`, `args` and
`env` instead, and the command must be installed on whichever machine runs the
agent. A remote runner is sent these definitions only over https, because they
carry credentials.

## GitHub Enterprise Server

Two settings, by environment or in `companiond.json`:

```sh
COMPANION_GITHUB_API_URL=https://ghe.corp/api/v3   # must include the API path
COMPANION_GITHUB_HOST=ghe.corp
```

They drive the REST client, `git clone`, the `gh --hostname` used to adopt your
local identity at boot, and the GitHub links in the UI. Defaults are github.com.

## Behind an egress proxy

Set `HTTP_PROXY` / `HTTPS_PROXY` and `NO_PROXY`. The daemon installs a
proxy-aware dispatcher at boot when one of them is present, and logs which one it
used. See [`../ENTERPRISE.md`](../ENTERPRISE.md) §6.
