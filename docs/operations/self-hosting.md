# Self-hosting the single-host alpha

Shelf's first runnable reference profile is deliberately small: one Shelf application/API process,
one isolated active-HTML renderer process, one PostgreSQL database, and one durable local-content
volume. The application process serves the built dark web client. It proves explicit
initialization, generated share URLs, and durable restart behavior; it is not yet a
high-availability or production-hardening guide.

## Known limitations

These are not planned for the current release cycle. Read them before you trust Shelf with
critical data:

- **No permanent purge.** Deletion is a soft-delete with a 30-day recovery window. After the
  window, content and metadata stay on disk invisibly — nothing destroys them yet. Treat
  "delete" as "hide", not "erase".
- **Recovery drills cover one profile only.** Verified backup and restore exist for host-native
  PostgreSQL with local content. There is no qualified recovery procedure for Docker Compose
  named volumes or for R2-backed content.
- **R2 is experimental.** The adapter is implemented and tested, but a validation run against
  live R2 has not been performed. Local storage is the qualified path.
- **No administrative password recovery.** A lost owner password requires database-level
  intervention.
- **No bulk import or export.** Artifacts enter and leave one at a time through the CLI and API.
- **Revision diffs are structural.** Comparison reports added, removed, changed, and moved
  entries — not line-level or content-aware differences — and has no web UI.
- **No TLS or reverse-proxy qualification.** Terminate TLS in front of Shelf with your own proxy
  configuration.

## Prerequisites

- Docker Engine with Docker Compose
- A host directory where an ignored `.env` file and protected secret files can live
- HTTPS at the externally visible `SHELF_AUTH_BASE_URL` unless the installation is loopback-only

Create local configuration without committing it:

```sh
cp .env.example .env
mkdir -p secrets
openssl rand -base64 48 > secrets/auth-secret.txt
openssl rand -base64 48 > secrets/share-signing-key.txt
chmod 600 secrets/auth-secret.txt secrets/share-signing-key.txt
```

Replace `POSTGRES_PASSWORD` in `.env` with a URL-safe random value. Set `SHELF_AUTH_BASE_URL` to
the application origin users will open and `SHELF_RENDERER_PUBLIC_ORIGIN` to a separately
reachable renderer origin on a different hostname, not merely another port on the application
hostname. The renderer receives the share-signing key and persistence settings, but not the
authentication secret or Shelf session cookie. The authentication and share-signing secrets must
remain independent; rotating the latter invalidates existing share links. `.env` and `secrets/`
are ignored by Git. The example uses `127.0.0.1` for Shelf and `localhost` for the renderer during
loopback-only operation. Shelf's session cookie is host-only. If a custom authentication or proxy
configuration adds a parent-domain `Domain` attribute, place the renderer on an unrelated
registrable domain rather than a sibling subdomain; otherwise renderer requests fail closed.

## Start and inspect

```sh
docker compose up --build -d
docker compose ps
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready
curl --fail http://127.0.0.1:3001/
```

Compose waits for PostgreSQL health, runs `shelf-admin migrate` as a successful one-shot
prerequisite, starts the isolated renderer, and then starts Shelf. API and renderer startup never
mutate the schema. `/health/live` reports only that the application process is serving;
`/health/ready` checks current migrations, PostgreSQL, and adapter readiness without returning
dependency details. Local storage performs its write-and-fsync probe once per process at startup
rather than on every health poll.

## Bootstrap the owner

Public registration is closed. Bootstrap the one installation owner explicitly. The password travels through standard input and never a command argument:

```sh
read -s SHELF_OWNER_PASSWORD
printf '%s' "$SHELF_OWNER_PASSWORD" | docker compose run -T --rm --no-deps shelf \
  node dist/operator/cli.js owner bootstrap \
  --email owner@example.com \
  --name "Shelf Owner" \
  --password-file - \
  --grant workspace-main:file.publish \
  --grant workspace-main:revision.read
unset SHELF_OWNER_PASSWORD
```

Every grant is explicit. Valid actions in the current slice are `file.publish` and `revision.read`.

## Manage agent credentials

Issue a credential for an agent:

```sh
docker compose run --rm --no-deps shelf node dist/operator/cli.js \
  credential issue --name release-agent \
  --grant workspace-main:file.publish \
  --grant workspace-main:revision.read
```

The JSON response is the only time the bearer token is returned. Store it in an appropriate secret manager. It is not shown by later commands.

```sh
docker compose run --rm --no-deps shelf node dist/operator/cli.js credential list
docker compose run --rm --no-deps shelf node dist/operator/cli.js \
  credential rotate --credential-id crd_example
docker compose run --rm --no-deps shelf node dist/operator/cli.js \
  credential revoke --credential-id crd_example
```

Rotation intentionally leaves the previous credential active so an operator can verify the replacement before revoking the old one. Revoke is idempotent for credentials belonging to this installation.

## Restart and data ownership

```sh
docker compose stop shelf
docker compose start shelf
curl --fail http://127.0.0.1:3000/health/ready
```

PostgreSQL metadata lives in `postgres-data`; sealed and staged content lives in `shelf-content`. `docker compose down` preserves them. `docker compose down --volumes` deletes both and is destructive.

Run a read-only storage reconciliation scan while PostgreSQL is available:

```sh
docker compose run --rm --no-deps shelf node dist/operator/cli.js reconcile scan
```

The JSON report uses a 24-hour candidate age by default and never deletes content. See the
[persistence operation](persistence.md#read-only-reconciliation) for classifications and the
explicit `--minimum-age-seconds` override.

## Current limits

This reference runs exactly one writing Shelf application process when local storage is selected,
plus one separately configured renderer process that resolves shared content. Shelf now has a
verified host-native PostgreSQL/Local File recovery workflow, but the current runtime image does
not include PostgreSQL client tools and the command does not yet orchestrate Compose named volumes.
Compose-volume recovery, R2 recovery, destructive orphan cleanup, administrative password
recovery, TLS/reverse-proxy qualification, rolling upgrades, and a live R2 conformance run remain
roadmap work. Least-privilege read-only database/storage credentials for the renderer are also
still open. Do not scale the local-storage writer horizontally or represent this Compose profile as
backup-qualified yet.
