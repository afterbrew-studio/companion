# README media

The images the README embeds, and the sources they are regenerated from. They
are taken from a **throwaway instance with invented data**, never from a real
workspace, so nothing here has to be redacted before it ships.

| File | Source |
| --- | --- |
| `cli.gif` | `cli.tape`, a [VHS](https://github.com/charmbracelet/vhs) script. `vhs docs/media/cli.tape` |
| `overview.png`, `run.png`, `modules.png` | `scripts/demo-shots.mjs`, headless Chrome over CDP at 1440×900 @2x |

## Regenerating

The demo instance is built from scratch each time, so the screenshots always
show the current build rather than whatever an old data directory held.

```sh
rm -rf /tmp/companion-demo/.companion
vhs docs/media/cli.tape                                    # records the GIF, and leaves a migrated data directory behind

node scripts/demo-github-stub.mjs &                        # the fake GitHub the demo repositories resolve through
COMPANION_HOME=/tmp/companion-demo/.companion \
  COMPANION_GITHUB_API_URL=http://127.0.0.1:8902 \
  node apps/api/dist/index.js &                            # needs a current `pnpm build`

node scripts/demo-seed.mjs  --home /tmp/companion-demo/.companion
node scripts/demo-shots.mjs --url http://127.0.0.1:8901
```

Seed after the daemon has booted, not before: boot marks any run left `running`
as interrupted, which would take the live run out of the shots.

`demo-shots.mjs --theme light` captures the light theme instead; the README
embeds the dark one.

## Why a GitHub stub

Repository access is graded from what GitHub reports for the resolving token, so
seeded rows alone read as "no access" and every issue and PR view renders empty.
`demo-github-stub.mjs` answers that one question and returns empty feeds for
everything else. Sync only upserts, so the seeded rows stand.
