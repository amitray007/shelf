# Authentication and authorization

Shelf separates login mechanics from product authorization. Better Auth owns the self-hosted human identity, password, and PostgreSQL-backed browser session. Shelf owns provenance actors, workspace/action grants, and opaque access credentials used by the CLI and agents.

## Authentication paths

| Caller | Credential | Authentication result | Authorization source |
|---|---|---|---|
| Browser owner | Better Auth secure cookie | Shelf human actor mapped from the Better Auth user ID | `shelf_actor_grants` |
| CLI or agent | `Authorization: Bearer shf_v1...` | Stable Shelf service actor | `shelf_actor_grants` |
| Protected viewer | Fragment capability once, then a signed tab-scoped viewer token | One idempotent viewer session | Share lifecycle and optional session budget |
| Public viewer | Short Public selector | Anonymous read until expiry or revocation | Share lifecycle |

A browser session never becomes an agent bearer token. A service actor may have overlapping credentials during deliberate rotation, so provenance remains attached to the actor rather than changing with each secret.

Protected capabilities are captured from the URL fragment and scrubbed before anonymous requests. Successful establishment consumes at most one use for the client-generated session ID and returns a signed token that is stored only in `sessionStorage`; refresh and token renewal reuse that session without another consumption. The token is bound to its share and session, expires within 24 hours and never after the share itself, and is rechecked against revocation and expiry on every access. Public selectors are intentionally non-confidential, but their links remain unlisted, non-indexed, and time-limited. Neither viewer path sends owner cookies or agent bearer credentials.

## Database setup

Better Auth `1.6.29` is pinned. Its reviewed tables live in the PostgreSQL `auth` schema; Shelf actors, grants, credential digests, last-use state, and append-only lifecycle events live in Shelf-owned tables. Apply both sets through the normal explicit migration command:

```sh
DATABASE_URL=postgresql://shelf:...@postgres:5432/shelf \
  pnpm --filter @shelf/postgres migrate
```

API construction never runs migrations. A Better Auth upgrade must generate and review its schema difference before changing the pinned version or the migration.

## Human owner bootstrap

Public email registration is always disabled in `createHumanAuth()`. The first owner is created only through the server-side `bootstrapShelfOwner()` service, which requires an explicit installation ID and initial workspace/action grants. PostgreSQL serializes bootstrap attempts for that installation with a session advisory lock and enforces one human owner per installation with a partial unique index. A replay is rejected.

The server distribution ships a separate `shelf-admin owner bootstrap` command. It accepts a password only through a protected file or standard input, never a password argument, log, or committed environment file. Administrative password recovery remains later T5 work; it must use Better Auth recovery mechanics without inventing a second password store.

Human auth assembly requires a PostgreSQL connection string, the externally visible HTTPS base URL, and a high-entropy Better Auth secret. The current tests use loopback HTTP only. Session cookie caching is disabled, so server-side session revocation is enforced on the next request without a cache grace period.

## Access credentials

`createAccessCredentialService()` issues a token shaped like `shf_v1.<public-id>.<secret>`. The token is returned once. PostgreSQL stores its non-secret credential ID and a SHA-256 digest, never the raw token. Do not place a token in a query string, CLI argument, publisher metadata, log, audit payload, or API response after issuance.

Every credential belongs to one stable service actor. Grants are exact tuples of installation, actor, workspace, and action. Authentication checks the digest, expiry, revocation, and actor state; authorization is a separate exact grant lookup. Installation-coupled foreign keys prevent an actor from administering another installation even if a caller supplies a known actor ID.

Rotation creates a replacement credential for the same actor and intentionally leaves the previous credential active. Verify the replacement, then revoke the old credential explicitly. After revocation commits, subsequent authentication fails closed. Credential lifecycle reads and audit events contain IDs and timestamps but no bearer secrets.

## Current boundary

The injectable API mounts Better Auth below `/api/auth/*` and accepts either a valid owner cookie or Shelf bearer credential at the existing API authentication seam. All `/api/v1` operations still require an explicit workspace/action authorization check. Better Auth endpoints are hidden from the Shelf `/api/v1` OpenAPI artifact because they are a separately versioned integration surface.

The production server, host-local operator executable, and authenticated web utility are present. A human owner signs in through Better Auth, discovers only their Shelf workspace grants, and can issue, list, and revoke scoped agent credentials through cookie-authenticated `/api/v1` routes. The token is returned only by the successful issue response; the browser keeps it only in component state until the reveal dialog closes, while later lists expose IDs, grants, timestamps, and status only. Bearer credentials cannot call these human-session administration routes.

The portable `shelf` CLI remains a remote artifact client, while `shelf-admin` remains the host-local recovery and bootstrap boundary. Password recovery, social login, passkeys, external OIDC, teams, invitations, Better Auth Organizations, and Better Auth machine-token plugins remain deferred.
