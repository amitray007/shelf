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
- A host directory where an ignored `.env` file can live, or a deployment platform that supplies
  Compose environment variables
- A reverse proxy that can route to Docker services, such as Dokploy's managed Traefik
- HTTPS at the externally visible `SHELF_AUTH_BASE_URL` unless the installation is loopback-only

Shelf uses one `docker-compose.yaml` for local single-host and managed Compose deployments. Create
local configuration without committing it:

```sh
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

For a fresh installation, run `openssl rand -hex 32` four times and put a different result in
`POSTGRES_PASSWORD`, `SHELF_AUTH_SECRET`, `SHELF_SHARE_SIGNING_KEY`, and `SHELF_PRIVACY_KEY`. Set
`SHELF_AUTH_BASE_URL` to the application origin users will open and
`SHELF_RENDERER_PUBLIC_ORIGIN` to a separately reachable renderer origin on a different hostname,
not merely another port on the application hostname. The renderer receives the share-signing key
and persistence settings, but not the authentication secret, privacy key, or Shelf session cookie.
The three application secrets must remain independent; rotating the share-signing key invalidates
existing protected share links. Compose mounts the three application secrets as files inside only
the services that need them. `.env` is ignored by Git.

In Dokploy, select `./docker-compose.yaml`, put the same variables in the Environment tab, enable
isolated deployments, and configure two domains: the Shelf hostname routes to service `shelf` on
port `3000`, while the renderer hostname routes to service `renderer` on port `3001`. The Compose
file intentionally publishes no host ports because the reverse proxy reaches both services over
their Docker network. Shelf's session cookie is host-only. If a custom authentication or proxy
configuration adds a parent-domain `Domain` attribute, place the renderer on an unrelated
registrable domain rather than a sibling subdomain; otherwise renderer requests fail closed.

When upgrading from the older `compose.yaml`, do not generate replacement values for existing
credentials. Keep the current `POSTGRES_PASSWORD`, copy the contents of the existing auth,
share-signing, and privacy key files into `SHELF_AUTH_SECRET`, `SHELF_SHARE_SIGNING_KEY`, and
`SHELF_PRIVACY_KEY`, then remove the corresponding `_FILE` entries from `.env`. Generate a new
privacy key only if the old installation never had one. Changing the database password does not
update an existing PostgreSQL volume, changing the auth secret invalidates sessions, and changing
the share-signing key invalidates protected links.

Before starting the upgraded stack, remove any leftover `compose.yaml` because Compose prefers it
over `docker-compose.yaml`. The new Compose file creates container secret files from the inline
values, so the old local `secrets/` directory is no longer used after its values have been migrated.

## Start and inspect

```sh
docker compose up --build -d
docker compose ps
docker compose exec shelf node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>{if(!r.ok)process.exit(1)})"
docker compose exec renderer node -e "fetch('http://127.0.0.1:3001/').then(r=>{if(!r.ok)process.exit(1)})"
curl --fail https://shelf.example.com/health/live
curl --fail https://shelf.example.com/health/ready
curl --fail https://renderer.example.com/
```

The two `docker compose exec` checks verify the containers before proxy domains exist. The HTTPS
checks verify the external routing after the two domains are configured.

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
curl --fail https://shelf.example.com/health/ready
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
