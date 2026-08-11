# Backup and restore drill

A backup is accepted only after an isolated restore proves that the database,
separate encryption key, application version, and operator procedure work
together. Run this before a company pilot, after a storage/key change, and at
least quarterly during the pilot.

## Scope and targets

Record before starting:

- source Companion version and image digest;
- recovery point objective (RPO) and recovery time objective (RTO);
- database backup location and retention class;
- Companion key location/owner and runtime-provider credential recovery path;
- drill owner, reviewer, start time, and isolated target host/network.

The database backup does **not** contain clones/worktrees, provider credential
homes, or the Companion secret key. GitHub data is reacquired from GitHub after
restore. The provider volume must be backed up separately if losing configured
runtime credentials is outside the accepted recovery plan.

## Create and protect the backup

For Compose, create the consistent snapshot while the source may remain live,
then copy it off the application volume:

```sh
stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose exec -T companion companion backup "/data/companion-$stamp.db"
docker compose cp "companion:/data/companion-$stamp.db" "./companion-$stamp.db"
sha256sum "./companion-$stamp.db"
```

Copy the matching `COMPANION_SECRET_KEY_FILE` through the organisation's secret
recovery process. If the deployment still uses `/data/secret-key`, copy it to a
different encrypted access-controlled destination; never attach it to the same
ticket or archive as the database. Record hashes and custody without printing
the key.

## Restore in isolation

Use an empty home, the exact released image, no production integration
credentials, and a loopback-only test port. Ensure the mounted home is writable
by uid/gid `1000`.

```sh
mkdir -m 700 ./companion-restore-home
# Recover the key as ./companion-restore-home/secret-key with mode 0600.

docker run --rm --user 1000:1000 \
  -v "$PWD/companion-restore-home:/data" \
  -v "$PWD/companion-$stamp.db:/restore.db:ro" \
  --entrypoint companion \
  companion:<version> --home /data restore /restore.db

docker run -d --name companion-restore-drill \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=256m,mode=1777 \
  -p 127.0.0.1:18901:8901 \
  -v "$PWD/companion-restore-home:/data" \
  -e COMPANION_AUTH_MODE=password \
  companion:<version>
```

Do not connect the restored instance to production webhooks, runners, OIDC,
notification endpoints, or a public proxy. If an environment value would
activate one, omit it or route it to a controlled stub.

## Verify

Record command output or screenshots for:

1. `curl -fsS http://127.0.0.1:18901/healthz` succeeds;
2. expected users, workspaces, repositories, roles, module configuration, and
   audit history are present;
3. one authorised login succeeds and one unauthorised action is denied/audited;
4. encrypted configuration can be read as set (without revealing plaintext),
   proving the recovered key matches;
5. database integrity remains `ok` and startup migrations complete;
6. expected GitHub state can be resynchronised with a non-production or
   read-only credential;
7. the measured recovery point and total recovery time meet the RPO/RTO.

Stop and remove only the isolated drill container after evidence is captured:

```sh
docker stop companion-restore-drill
docker rm companion-restore-drill
```

Keep or securely delete the isolated home according to the drill ticket. Do not
leave a second live copy of company data on a developer laptop.

## Evidence record

| Field | Result |
| --- | --- |
| Date / owner / independent reviewer | |
| Source version and image digest | |
| Backup and key recovery source | |
| Backup SHA-256 and integrity result | |
| Requested / achieved RPO | |
| Requested / achieved RTO | |
| Login, RBAC denial, audit, and secret-decryption proof | |
| Missing data or manual repair | |
| Credential/provider-volume recovery result | |
| Follow-up owner and due date | |

A failed or incomplete drill blocks the company pilot until the recovery plan
is corrected and repeated.
