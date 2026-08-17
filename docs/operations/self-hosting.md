# Self-hosting the single-host alpha

Shelf's first runnable reference profile is deliberately small: one Shelf API process, one PostgreSQL database, and one durable local-content volume. It proves explicit initialization and durable restart behavior; it is not yet a high-availability or production-hardening guide.

## Prerequisites

- Docker Engine with Docker Compose
- A host directory where an ignored `.env` file and protected auth-secret file can live
- HTTPS at the externally visible `SHELF_AUTH_BASE_URL` unless the installation is loopback-only

Create local configuration without committing it:

```sh
cp .env.example .env
mkdir -p secrets
openssl rand -base64 48 > secrets/auth-secret.txt
chmod 600 secrets/auth-secret.txt
```

Replace `POSTGRES_PASSWORD` in `.env` with a URL-safe random value and set `SHELF_AUTH_BASE_URL` to the URL users will actually open. `.env` and `secrets/` are ignored by Git. The example uses loopback HTTP only for local operation.

## Start and inspect

```sh
docker compose up --build -d
docker compose ps
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready
```

Compose waits for PostgreSQL health, runs `shelf-admin migrate` as a successful one-shot prerequisite, then starts Shelf. API startup itself never mutates the schema. `/health/live` reports only that the process is serving; `/health/ready` checks current migrations, PostgreSQL, and adapter readiness without returning dependency details. Local storage performs its write-and-fsync probe once at startup rather than on every health poll.

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

## Current limits

This reference runs exactly one Shelf process when local storage is selected. Backup/restore drills, orphan reconciliation, administrative password recovery, TLS/reverse-proxy qualification, rolling upgrades, and a live R2 conformance run remain roadmap work. Do not scale the local-storage service horizontally.
