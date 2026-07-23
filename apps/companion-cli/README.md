# @moxxy-ai/companion

Run the complete Companion dashboard locally without cloning the monorepo:

```sh
npx @moxxy-ai/companion
```

On a fresh machine, the CLI offers a short setup flow for the local admin. You
can enter a username, email, and password, or accept the recommended defaults:
`admin`, `admin@companion.local`, and a cryptographically random password shown
once in the confirmation box. Configuration and all Companion data live under
`~/.companion` by default.

When `gh` is authenticated for GitHub.com, interactive setup offers to connect
the active identity as a personal GitHub account owned by the new admin. The
token is requested from `gh` only after confirmation and is sent directly to
the local Companion API; it is never printed or written to the CLI setup files.

After setup, the command starts Companion on `http://127.0.0.1:8901` and opens
it in the default browser. Keep the terminal open; press Ctrl+C to stop.

## Commands

```sh
npx @moxxy-ai/companion             # setup if needed, start, open browser
npx @moxxy-ai/companion init        # setup only
npx @moxxy-ai/companion --no-open   # start without opening a browser
npx @moxxy-ai/companion --port 9000
npx @moxxy-ai/companion --home ./companion-data
```

Use `--yes` for a non-interactive first setup. The generated credential is
written to `<home>/.env` with owner-only permissions and printed once. Add
`--github-from-gh` to explicitly opt into importing the active `gh` identity in
non-interactive mode.

Node.js 20 or newer is required. The moxxy CLI is optional for the dashboard
itself, but agent runs require it on PATH (`npm i -g @moxxy/cli`).
