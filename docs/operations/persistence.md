# Persistence and content storage

Shelf uses PostgreSQL for authoritative metadata and selects content storage independently. A revision stores a provider-neutral opaque content ID, SHA-256 hash, and byte count; it does not store an R2 endpoint, filesystem path, credential, or public provider URL.

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

## Current qualification boundary

The automated suite covers local cancellation cleanup, immutable sealing, exact range reads, S3 single-part and bounded multipart upload, upload-failure cleanup, PostgreSQL migration/restart behavior, concurrent idempotency, rollback, and a PostgreSQL-plus-local restart flow.

A live private R2 bucket has not been exercised in this repository. Before calling the R2 profile production-qualified, run the same behavioral suite with real scoped credentials and verify multipart completion/abort, full and ranged reads, retries, and cleanup. Backup manifests, age-gated staging/orphan reconciliation, retention deletion, and restore drills remain deployment work under T5.

## Adding another provider

1. Keep publishing and read application modules dependent only on the core storage interfaces.
2. Reuse `S3ContentStorage` only when the provider passes the S3 behavioral suite; do not infer behavior from an “S3-compatible” label.
3. Implement a separate adapter for a native protocol such as Google Cloud Storage when that protocol provides a better operational fit.
4. Add provider configuration only to application assembly and environment parsing.
5. Preserve existing content IDs during copy-verify-switch migration; never make a provider path or ETag the only portable identity.
