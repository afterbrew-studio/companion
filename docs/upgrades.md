# Upgrading Companion

One binary carries the daemon, the SPA and the CLI, and the SQLite database
migrates forward automatically on boot. That makes the upgrade itself one
command; what deserves ceremony is the order around it, because migrations are
forward-only and the runner protocol is strict.

## Order of operations

1. **Back up the database.** `companion backup <file>` takes a consistent
   snapshot with `VACUUM INTO` and verifies it, and is safe while the daemon is
   running. If `COMPANION_BACKUP_DIR` is set, the daemon already keeps daily
   verified snapshots on its own (see
   [`configuration.md`](configuration.md#common-variables)); take a manual one
   anyway so the pre-upgrade state has an unambiguous file. Remember that a
   database snapshot deliberately excludes the `secret-key` file: keep that
   backed up through a separate secret path.
2. **Note the versions you are on.** The daemon version is in the UI footer and
   in `companion --version`; runner machines report theirs on the Runners page.
   A rollback needs the exact number, not "whatever was there before".
3. **Upgrade the daemon.** See the paths below.
4. **Watch the migrations.** On the first boot after an upgrade each module
   applies its pending migrations and logs them. A failed migration fails the
   boot loudly; nothing is served from a half-migrated schema. This is the
   moment the pre-upgrade backup exists for.
5. **Upgrade the runners.** The runner handshake checks protocol equality, not
   compatibility ranges: a runner whose `RUNNER_AGENT_PROTOCOL` differs from
   the daemon's shows as degraded with `agent protocol N != M (version
   mismatch)` and receives no work. Daemon and runner agent ship from the same
   release, so move every runner to the daemon's version as part of the same
   maintenance window, daemon first.
6. **Roll back by restoring, not by downgrading in place.** Stop the daemon,
   `companion restore <snapshot>`, then start the binary version that wrote
   that snapshot. An older binary must never boot on a newer database, which
   the downgrade guard below enforces.

## The downgrade guard

Each module records the migrations it has applied in a per-module ledger. On
boot, if any module's applied schema version is higher than the highest
migration this binary knows, the daemon refuses to start and names the module,
the applied version and the known version. That situation means the database
was already migrated by a newer Companion, and this build cannot know what
those migrations changed.

Two remedies, in order of preference:

- upgrade the binary back to (at least) the version that wrote the database, or
- restore the pre-upgrade backup and stay on the older version.

For recovery situations only, `COMPANION_ALLOW_SCHEMA_AHEAD=1` boots anyway and
logs a loud warning instead. Columns and tables this binary does not understand
are served as they are, so treat it as a way to read data out, not as a way to
keep operating.

## npx

`npx @moxxy/companion` resolves the latest published version at each cold
start, so upgrading is: stop the daemon, run it again. For deliberate control,
pin the version:

```sh
npx @moxxy/companion stop
npx @moxxy/companion@0.9.0        # upgrade to an exact version
```

Rollback: `companion restore <snapshot>`, then start the pinned old version,
`npx @moxxy/companion@<previous>`.

## Docker

Pull the release you are upgrading to and recreate the container; the volumes
carry all state:

```sh
docker pull ghcr.io/moxxy-ai/companion:0.9.0
docker compose up -d
```

Building from source at a release tag works the same way
(`docker compose up -d --build` on the checked-out tag). Avoid `latest` in
anything long-lived: an unplanned pull is an unplanned upgrade, and after one
the guard above is what stands between an accidental restart of an old
container and silent corruption. Rollback: stop the container, restore the
snapshot into the data volume, start the previous image tag.

## Version notes

Release notes and tags are on the
[GitHub releases page](https://github.com/moxxy-ai/companion/releases); how a
release is produced is in [`releases.md`](releases.md). The published image is
`ghcr.io/moxxy-ai/companion`, tagged with each release version, with an SPDX
SBOM of the image attached to the GitHub release.
