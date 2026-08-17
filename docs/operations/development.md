# Host-local development

Shelf can run directly on the host without Docker. The development profile uses the same
PostgreSQL, migration, authentication, and local-content adapters as the single-host deployment;
only its process supervision and paths are development-specific.

## Prerequisites

- Node.js 24 and pnpm 10
- PostgreSQL running locally with permission to create the `shelf_dev` database

Install dependencies and prepare the development profile:

```sh
pnpm install --frozen-lockfile
pnpm dev:setup
```

`dev:setup` performs four idempotent steps:

1. Create `.env.dev` with a freshly generated authentication secret and mode `0600`, unless the
   file already exists.
2. Create the configured local-content directory beneath the ignored `data/` directory.
3. Create the local PostgreSQL database if it is missing. Existing databases are never dropped,
   emptied, or recreated. Database creation is skipped for non-loopback PostgreSQL hosts.
4. Build the workspace and apply reviewed migrations explicitly.

Both `.env.dev` and `data/` are ignored by Git. Setup never replaces an existing `.env.dev`, so
local changes and credentials survive repeated runs.

## Configuration

The generated `.env.dev` contains:

```dotenv
DATABASE_URL=postgresql:///shelf_dev
SHELF_STORAGE_DRIVER=local
SHELF_STORAGE_LOCAL_ROOT=./data/dev-content
SHELF_INSTALLATION_ID=installation-dev
SHELF_AUTH_BASE_URL=http://127.0.0.1:3000
SHELF_AUTH_SECRET=<generated locally>
SHELF_HOST=127.0.0.1
SHELF_PORT=3000
```

Edit `DATABASE_URL` before rerunning `pnpm dev:setup` when the local PostgreSQL installation needs
an explicit user, password, host, or port. A non-loopback database must already exist; setup will
still build and migrate it but will not attempt administrative database creation.

## Run Shelf

```sh
pnpm dev
```

The command runs the TypeScript build in watch mode and restarts the compiled Shelf server when
source output changes. Stop both processes with `Ctrl-C`. Confirm the server is ready:

```sh
curl --fail http://127.0.0.1:3000/health/live
curl --fail http://127.0.0.1:3000/health/ready
```

`pnpm dev:check` performs a non-running preflight when diagnosing an incomplete setup.

Run a read-only metadata/storage reconciliation from another terminal when needed:

```sh
node --env-file=.env.dev apps/api/dist/operator/cli.js reconcile scan
```

The command reports age-gated candidates as JSON and never deletes local development content.

## Back up local development state

The host-native recovery flow uses `.env.dev` automatically. Stop `pnpm dev`, ensure PostgreSQL
client tools and `tar` are on `PATH`, then create a new ignored backup directory:

```sh
mkdir -p backups
pnpm build
pnpm backup:create:dev \
  --output backups/installation-dev-manual \
  --confirm-offline installation-dev
```

Restore is intentionally limited to a new empty database and a content root that does not exist
under an already-existing parent directory; it never overwrites the active development state. See
[Offline Local File backup and restore](persistence.md#offline-local-file-backup-and-restore) for
the recovery command, manifest, safety checks, and post-restore verification.

## Bootstrap and publish

Shelf never invents a development actor or authentication bypass. Bootstrap the owner once:

```sh
read -s SHELF_OWNER_PASSWORD
printf '%s' "$SHELF_OWNER_PASSWORD" | \
  node --env-file=.env.dev apps/api/dist/operator/cli.js owner bootstrap \
  --email owner@example.test \
  --name "Shelf Owner" \
  --password-file - \
  --grant workspace-main:file.publish \
  --grant workspace-main:revision.read
unset SHELF_OWNER_PASSWORD
```

Issue a development credential:

```sh
node --env-file=.env.dev apps/api/dist/operator/cli.js credential issue \
  --name local-cli \
  --grant workspace-main:file.publish \
  --grant workspace-main:revision.read
```

Copy the one-time token from the JSON response into the shell, then use the portable `shelf` CLI.
Within the repository, `pnpm shelf ...` runs that exact CLI identity without installing a global
package:

```sh
export SHELF_TOKEN='shf_v1...'
pnpm shelf publish \
  --url http://127.0.0.1:3000 \
  --workspace workspace-main \
  --file README.md \
  --idempotency-key local-readme-1 \
  --allow-insecure-loopback
```

The JSON result contains the stable artifact ID. Publish another immutable revision, then inspect
the latest descriptor and history:

```sh
pnpm shelf publish \
  --url http://127.0.0.1:3000 \
  --workspace workspace-main \
  --artifact art_... \
  --file README.md \
  --idempotency-key local-readme-2 \
  --allow-insecure-loopback
pnpm shelf artifacts list \
  --url http://127.0.0.1:3000 \
  --workspace workspace-main \
  --allow-insecure-loopback
pnpm shelf artifacts show \
  --url http://127.0.0.1:3000 \
  --artifact art_... \
  --allow-insecure-loopback
pnpm shelf artifacts history \
  --url http://127.0.0.1:3000 \
  --artifact art_... \
  --allow-insecure-loopback
pnpm shelf artifacts rename \
  --url http://127.0.0.1:3000 \
  --artifact art_... \
  --name "Project notes" \
  --allow-insecure-loopback
pnpm shelf artifacts restore \
  --url http://127.0.0.1:3000 \
  --workspace workspace-main \
  --artifact art_... \
  --revision rev_... \
  --idempotency-key local-readme-restore-1 \
  --allow-insecure-loopback
unset SHELF_TOKEN
```

Use a new idempotency key after changing the file, target artifact, semantic metadata, or restore
source. Rename changes only the artifact's display name. Restore creates a new immutable latest
revision whose provenance names the selected source; it does not rewrite or duplicate stored
content bytes.
