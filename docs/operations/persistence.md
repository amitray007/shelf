# Persistence and content storage

Shelf uses PostgreSQL for authoritative metadata and selects content storage independently. A file revision stores one provider-neutral opaque content ID, SHA-256 hash, and byte count. A folder revision stores one canonical manifest descriptor plus a transactional entry set whose regular files each carry the same provider-neutral descriptor; empty directories remain explicit. Neither model stores an R2 endpoint, filesystem path, credential, or public provider URL.

## Supported profiles

| Profile | Metadata | Content | Topology |
|---|---|---|---|
| Single-host self-hosted | PostgreSQL | Local filesystem | One API host with a durable local content volume |
| Hosted object storage | PostgreSQL | Cloudflare R2 | One or more API processes sharing PostgreSQL and one private R2 bucket |

The local profile keeps Shelf usable without a proprietary content service. R2 is optional and is the first hosted provider configured through the generic S3-protocol adapter. AWS S3 can reuse that adapter after its conformance suite passes. A future native GCP adapter can satisfy the same `ContentStore` and `ContentReader` interfaces without changing core publishing or delivery.

## Configuration

Application assembly uses `shelfPersistenceConfigFromEnv()` and `createShelfPersistence()`. Environment loading itself belongs to the eventual deployment entrypoint; Shelf does not implicitly read a `.env` file.

All profiles require:

```text
DATABASE_URL=postgresql://shelf:...@postgres:5432/shelf
SHELF_STORAGE_DRIVER=local|r2
```

Local storage requires:

```text
SHELF_STORAGE_LOCAL_ROOT=/var/lib/shelf/content
```

The root must be a durable volume accessible to exactly one Shelf API host. Staging and sealed objects remain under that root on the same filesystem. Shelf creates restrictive directories and files, fsyncs staged bytes, and seals content without replacing an existing object.

R2 requires:

```text
SHELF_R2_ACCOUNT_ID=...
SHELF_R2_BUCKET=shelf-content
SHELF_R2_ACCESS_KEY_ID=...
SHELF_R2_SECRET_ACCESS_KEY=...
SHELF_STORAGE_PREFIX=shelf
```

`SHELF_R2_SESSION_TOKEN` is optional for temporary credentials. Keep the bucket private and scope its token to Object Read & Write for that bucket. Shelf uses the account-scoped R2 S3 endpoint, `auto` region, bounded multipart uploads, exact range reads, and opaque keys beneath the configured prefix. Shelf share links must continue to terminate at Shelf rather than exposing provider URLs.

Run migrations explicitly before starting upgraded API replicas:

```sh
DATABASE_URL=postgresql://shelf:...@postgres:5432/shelf \
  pnpm --filter @shelf/postgres migrate
```

Migrations are not run automatically during API construction. Kysely serializes concurrent PostgreSQL migration runners with an advisory lock, but deployment should still use one deliberate migration job.

## Read-only reconciliation

The host-local operator can compare installation-scoped PostgreSQL references with the configured
content backend:

```sh
node --env-file=.env.dev apps/api/dist/operator/cli.js reconcile scan
```

The command emits one versioned JSON report and does not delete or modify storage. It reports
healthy references, referenced content that is missing or has the wrong byte count, sealed objects
without metadata, stale staging, recently created objects deferred by the age gate, and a count of
unrecognized provider entries. The default candidate age is 86,400 seconds (24 hours); an operator
may select another value of at least 60 seconds:

```sh
node --env-file=.env.dev apps/api/dist/operator/cli.js reconcile scan \
  --minimum-age-seconds 3600
```

Local inventory reads the `staging/` and `objects/` directories without following unknown entries.
The S3-protocol inventory lists completed objects plus incomplete multipart uploads beneath the
configured Shelf prefix. Database references remain scoped by `SHELF_INSTALLATION_ID`; independent
installations must still use independent local roots or object prefixes. Folder manifest objects and
every regular-file entry are independent references, so reconciliation and backup verification cover
the complete browsable snapshot rather than only its manifest.

The reported orphan and staging entries are candidates, not proof that deletion is safe. A later
destructive command must perform a fresh reference check, retain an independently configurable age
gate, and remain separately disableable. No such command exists in this slice.

## Offline Local File backup and restore

The first recovery workflow targets a host-native PostgreSQL plus Local File installation. It
requires `pg_dump`, `pg_restore`, `psql`, and `tar` on `PATH`. Use a PostgreSQL client major version
that can dump the configured server. The workflow does not support R2 and does not yet orchestrate
the named volumes in the Docker Compose reference profile.

Stop every Shelf process and any other writer first. The confirmation value must exactly match
`SHELF_INSTALLATION_ID`. Run the command from a shell that already provides the normal Shelf
environment; the generic pnpm command does not choose an environment file implicitly:

```sh
mkdir -p backups
pnpm build
pnpm backup:create \
  --output backups/installation-dev-2026-08-17 \
  --confirm-offline installation-dev
```

Creation refuses an existing or overlapping output directory, a database containing another Shelf
installation, and unrecognized Local File entries such as symlinked object paths. It independently
reads and hashes every PostgreSQL-referenced object, creates `metadata.dump` in PostgreSQL custom
format and a complete `content.tar`, checks the installation/reference sets again, then writes
`manifest.json` last. The v1
manifest records the installation, offline consistency assertion, referenced content IDs,
SHA-256 hashes, byte counts, revision counts, and archive checksums. The directory and all three
files are protected for the current user. `backups/` is ignored by Git.

Treat the complete directory as sensitive: it contains owned content plus database state such as
password and credential hashes plus active session records. Copy it to durable storage with access
controls before relying on it as a recovery point. A backup is not the portable artifact export
promised by R24.

Restore only while Shelf remains stopped. Point the environment at an already-created **empty**
PostgreSQL database and a Local File root that does **not** exist beneath an existing parent
directory, then run:

```sh
DATABASE_URL=postgresql:///shelf_restore \
SHELF_STORAGE_LOCAL_ROOT=./data/restored-content \
pnpm backup:restore \
  --from backups/installation-dev-2026-08-17 \
  --confirm-offline installation-dev
```

Restore verifies the manifest and both archive checksums before touching the target. It refuses a
database containing user-defined database objects, refuses an existing content root, extracts
content into a new root, restores PostgreSQL in one transaction, verifies current migrations, and
streams every referenced object to confirm its byte count and SHA-256 hash. It never clears or replaces an
existing database or content directory. Keep Shelf stopped if any step fails; repair or choose new
empty targets before retrying.

After success, run `reconcile scan`, start Shelf, and verify an important pinned revision before
retiring the original data. The automated integration drill performs this recovery into disposable
PostgreSQL and Local File targets.

## Current qualification boundary

The automated suite covers local cancellation cleanup, immutable sealing, exact range reads, S3 single-part and bounded multipart upload, upload-failure cleanup, provider inventory, PostgreSQL migration/restart behavior, concurrent idempotency, rollback, read-only reconciliation, a PostgreSQL-plus-local restart flow, and offline Local File backup/restore into clean targets.

A live private R2 bucket has not been exercised in this repository. Before calling the R2 profile production-qualified, run the same behavioral suite with real scoped credentials and verify multipart completion/abort, full and ranged reads, pagination, retries, inventory, and cleanup. R2 recovery, Docker Compose named-volume orchestration, online snapshots/PITR, destructive age-gated cleanup, and scheduled retention remain deployment work under T5.

## Adding another provider

1. Keep publishing, read, reconciliation, and backup verification modules dependent only on the core storage interfaces.
2. Reuse `S3ContentStorage` only when the provider passes the S3 behavioral suite; do not infer behavior from an “S3-compatible” label.
3. Implement a separate adapter for a native protocol such as Google Cloud Storage when that protocol provides a better operational fit.
4. Add provider configuration only to application assembly and environment parsing.
5. Preserve existing content IDs during copy-verify-switch migration; never make a provider path or ETag the only portable identity.
