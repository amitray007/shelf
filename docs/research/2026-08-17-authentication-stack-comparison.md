# Authentication stack comparison for Shelf

**Status:** research note, not a decision
**Date checked:** 2026-08-17
**Scope:** Better Auth, Clerk, Auth.js, Stack Auth/Hexclave, ZITADEL, Keycloak, and Ory

## Executive read

The strongest fit is **Better Auth for human identity and browser sessions, with Shelf-owned actors, access credentials, workspace grants, rotation, revocation, and audit state**.

This is not a recommendation to build human authentication from scratch. Better Auth supplies the difficult browser-facing mechanics: sign-in, session cookies, session revocation, recovery-capable identity records, and future social/OIDC providers. Shelf should own the smaller, product-specific machine credential boundary because a Shelf credential is more than an authentication token: it is an auditable actor with grants to specific Shelf workspaces and actions.

The comparison does not support using Clerk as Shelf's required auth layer. Clerk has excellent Fastify, organization, and API-key products, but its documented production architecture uses Clerk-hosted Frontend and Backend APIs, and its API keys are a metered paid feature. An MIT SDK is not a self-hosted identity data plane. That conflicts with Shelf's requirement to run without a mandatory proprietary dependency. ([Clerk architecture](https://clerk.com/docs/guides/how-clerk-works/overview), [Clerk API keys](https://clerk.com/docs/guides/development/machine-auth/api-keys), [Clerk JavaScript SDK license](https://github.com/clerk/javascript))

Auth.js is no longer the best greenfield choice: its own repository says it is now part of Better Auth and recommends Better Auth for new projects except for specific gaps such as database-free stateless sessions. Stack Auth, now documented and developed as Hexclave, is self-hostable but materially raises the operating floor. ZITADEL, Keycloak, and the Ory services are credible external identity platforms, but they solve a broader IAM problem than Shelf v1 has and should remain possible future OIDC integrations rather than required deployment components. ([Auth.js repository](https://github.com/nextauthjs/next-auth), [Hexclave self-hosting](https://docs.hexclave.com/guides/other/self-host), [ZITADEL requirements](https://zitadel.com/docs/self-hosting/manage/requirements), [Keycloak server guide](https://www.keycloak.org/docs/latest/server_admin/), [Ory Kratos](https://www.ory.com/kratos))

## The boundary Shelf actually needs

The current product contract targets one owner with multiple isolated workspaces; multi-user teams are deferred. The authentication design should therefore distinguish four concepts:

1. **Human identity:** who can establish an interactive browser session.
2. **Actor:** the provenance identity recorded for an operation; a human and each CLI/agent credential should be distinguishable actors.
3. **Credential:** the secret used to authenticate an actor, with expiration, revocation, rotation, and last-use state.
4. **Grant:** the workspaces and actions that credential may use.

Authentication answers who presented a valid credential. Shelf authorization answers whether that actor may perform this action in this workspace. Those checks should not collapse into a session-exists check, an auth-provider organization role, or an unstructured token metadata field.

## Comparison matrix

| Candidate | Deployment and license | Human browser auth | CLI/agent credential fit | Schema and operations | Shelf read |
|---|---|---|---|---|---|
| **Better Auth** | In-process TypeScript library; MIT; no required hosted data plane. | Database-backed cookie sessions, email/password and social providers; official Fastify integration. | Official API Key plugin has good issuance and verification primitives, but its ownership and permission model does not fully model Shelf actors and workspace grants. | Built-in PostgreSQL adapter uses Kysely; CLI can generate SQL or directly migrate its tables. | **Best human-auth foundation. Keep Shelf authorization and machine credentials in Shelf.** |
| **Clerk** | Managed identity service; JavaScript SDK is MIT, but production FAPI/BAPI are Clerk services. | Best-in-class hosted components, sessions, organizations, and official Fastify SDK. | User/org API keys, granular scopes, expiration, revoke, and UI; verification and creation are usage-priced. | Vendor owns identity schema and operational control plane. | **Reject as a mandatory dependency.** Reasonable optional hosted integration only if Shelf later supports external identity. |
| **Auth.js** | In-process, ISC, owns app data. | Strong OAuth/session foundation across selected frameworks. | No first-party Shelf-shaped API-key/workspace credential subsystem was found. | Multiple database adapters; no official Fastify package is presented on the current homepage. | **Do not start a new Shelf integration here.** Its maintainers recommend Better Auth for new projects. |
| **Stack Auth / Hexclave** | Self-hostable; clients generally MIT, server components generally AGPLv3. | Prebuilt identity and team UI, sessions, permissions. | User and team API keys with create/list/revoke UI and expiration. | Supported self-host path requires its own server, Postgres, cron, reverse proxy, email; current docs also list ClickHouse and S3 for the supported deployment. | **Too much separate platform for Shelf v1.** Rebrand and deployment expansion also increase churn risk. |
| **ZITADEL** | Separate Go service; main repository AGPL-3.0-only with documented exceptions; requires PostgreSQL and an HTTP/2-capable reverse proxy. | Full CIAM/IAM, login UI, organizations, OIDC/OAuth. | Service accounts support private-key JWT, client credentials, and PATs. | Own database initialization, setup, runtime, login client, proxy, and upgrade path. | **Strong future external IdP option, excessive default dependency.** |
| **Keycloak** | Separate Java service; Apache-2.0. | Mature OIDC/OAuth/SAML, admin UI, realms, users, sessions. | Service accounts and OAuth client-credentials flow; not a native Shelf personal-access-key model. | Own server, realm/client configuration, database, upgrades, and bootstrap administration. | **Reliable enterprise IdP, wrong v1 operating floor.** |
| **Ory Kratos/Hydra/Keto** | Separate Go services; open-source cores, with managed and enterprise offerings. Kratos and Hydra are Apache-2.0. | Kratos handles identity; Hydra handles OAuth/OIDC; Keto handles permissions. | Hydra supports client credentials; composing durable Shelf API keys and workspace grants still remains application work. | Multiple independently deployed services and schemas for the complete identity/authorization story. | **Powerful composition for a later IAM platform, not the smallest complete Shelf design.** |

## Better Auth: verified facts

### Framework, Fastify, and self-hosting

- Better Auth is an MIT-licensed TypeScript authentication framework. Its server runs with the application and uses an application-supplied database; the official project does not require a hosted Better Auth data plane. ([repository](https://github.com/better-auth/better-auth), [license](https://github.com/better-auth/better-auth/blob/main/LICENSE.md))
- The official Fastify integration mounts a `GET`/`POST` catch-all that forwards Web `Request` objects to `auth.handler`. Protected Fastify routes call `auth.api.getSession` after converting Node headers with `fromNodeHeaders`. ([Fastify integration](https://better-auth.com/docs/integrations/fastify))
- PostgreSQL is a built-in path: pass a `pg.Pool`; Better Auth uses Kysely underneath and supports a non-default PostgreSQL schema through `search_path`. ([PostgreSQL adapter](https://better-auth.com/docs/adapters/postgresql))
- Better Auth can generate an SQL schema file for its built-in Kysely adapter or directly inspect and migrate a database. Plugins contribute their own tables and columns. ([database guide](https://better-auth.com/docs/concepts/database), [CLI guide](https://better-auth.com/docs/concepts/cli))

### Human sessions

- Better Auth's standard model is a database-backed cookie session. The session token is the cookie value and the default session expiry is seven days. ([session management](https://better-auth.com/docs/concepts/session-management))
- Its cookies are `httpOnly`, and are `secure` in production. The documented default `SameSite` setting is `Lax`. ([cookies](https://better-auth.com/docs/concepts/cookies), [security](https://better-auth.com/docs/reference/security))
- Cookie caching is optional. The documentation explicitly warns that a revoked session may remain usable until the cache `maxAge` passes; disabling the cache gives immediate database-backed revocation. ([session caching](https://better-auth.com/docs/concepts/session-management#session-caching))

### API Key plugin

The official `@better-auth/api-key` plugin is more capable than a bare bearer-token helper:

- It creates, verifies, gets, lists, updates, and deletes keys and supports expiration, enable/disable state, rate limits, metadata, prefixes, and resource/action permissions. ([API Key plugin](https://better-auth.com/docs/plugins/api-key), [reference](https://better-auth.com/docs/plugins/api-key/reference))
- A key can reference either a Better Auth user or a Better Auth organization. Organization-owned keys integrate with the Organization plugin's roles controlling who may manage keys. ([reference](https://better-auth.com/docs/plugins/api-key/reference), [organization-key behavior](https://better-auth.com/docs/plugins/api-key/advanced))
- The raw secret is included in the creation result. Subsequent get, list, update, and verify results omit the `key`, so the API has the necessary primitive for a show-once UI. ([create/get/list contract](https://better-auth.com/docs/plugins/api-key))
- The schema stores the key digest, an optional clear prefix/start, owner reference, timestamps, expiration, enabled state, request counters, permissions, and metadata. Hashing is enabled by default; the docs warn against disabling it. ([schema and hashing option](https://better-auth.com/docs/plugins/api-key/reference))
- Current official source hashes the full generated key with SHA-256 and base64url-encodes the digest before lookup/storage. ([source at the revision checked](https://github.com/better-auth/better-auth/blob/58c49eb97f04ff18aa823318a3856a013353fdc2/packages/api-key/src/index.ts#L27-L34))
- The default header is `x-api-key`, but the plugin accepts custom headers or a custom key getter. Shelf could therefore preserve `Authorization: Bearer ...` if it adopted the plugin. ([plugin reference](https://better-auth.com/docs/plugins/api-key/reference))
- API keys do not become sessions by default. Better Auth says session mocking from user-owned API keys is generally not recommended because a leaked key can impersonate its user. ([advanced API-key behavior](https://better-auth.com/docs/plugins/api-key/advanced#sessions-from-api-keys))

Security maintenance is a real part of adopting this plugin. Better Auth supports only its latest version, and the API-key plugin had a high-severity authorization bypass in version 1.3.25, fixed in 1.3.26, that allowed unauthenticated creation or update for arbitrary users. This is evidence for prompt patching, pinned/version-reviewed upgrades, and hostile authorization tests; it is not evidence that the current patched plugin is unusable. ([support policy](https://github.com/better-auth/better-auth/security), [advisory](https://github.com/better-auth/better-auth/security/advisories/GHSA-99h5-pjcv-gr6v))

## Does Better Auth's API Key and Organization stack cover Shelf?

### What it covers adequately

As a credential primitive, the API Key plugin covers most low-level mechanics Shelf needs: secure random issuance, hashed-at-rest lookup, partial identification, show-once retrieval, expiry, disable/delete, last-request state, and action-like permissions. The Organization plugin covers organization members, invitations, roles, custom permissions, and optional teams. ([API Key plugin](https://better-auth.com/docs/plugins/api-key), [Organization plugin](https://better-auth.com/docs/plugins/organization))

### What it does not establish

It does not establish Shelf's authorization and provenance contract:

- API-key ownership is only `user` or `organization`; there is no first-class Shelf actor or workspace-grant relation.
- Plugin permissions are a serialized resource-to-actions record. Shelf needs relational grants to zero, one, or many workspace rows, plus installation-level capabilities.
- A key referencing the owner user still needs its own actor identity so provenance can distinguish the owner in a browser from agent A and agent B.
- No documented atomic rotate operation was found. Shelf must define create-new, reveal-once, explicit overlap, and revoke-old behavior.
- Generic key-management endpoints are not a substitute for Shelf audit events or for policy such as requiring a fresh owner session before issuing a powerful credential.
- Mapping every Shelf workspace to a Better Auth organization would import member/invitation/team semantics into a product whose first release explicitly has one owner and defers teams.

### Shelf inference

The plugins are therefore **not adequate as the sole T3 model**. The clean boundary is:

- Better Auth core owns the human owner record, sign-in/recovery flows, and browser sessions.
- Shelf owns `actor`, `access_credential`, `credential_workspace_grant`, and authentication/audit events.
- The authenticated Better Auth user maps to a Shelf human actor. A valid access credential maps directly to its own Shelf service actor.
- Shelf's authorizer evaluates installation/workspace/action grants for both kinds of actor.
- Better Auth Organization is not enabled until multi-user teams become an accepted product slice.

Using the API Key plugin only as a hashing/lifecycle engine with a Shelf grant table is technically possible, but it leaves a split credential transaction, plugin endpoint hardening, schema coupling, and rotation workflow for Shelf to own anyway. A small Shelf credential service based only on high-entropy opaque secrets, one-way digests, constant-time comparison where applicable, relational grants, and fail-closed lookup is the more coherent boundary. That code must receive dedicated security tests and review; this recommendation is not permission to invent passwords, browser sessions, OAuth, or recovery flows.

## Schema and migration ownership

Better Auth and Shelf can share one PostgreSQL service without sharing model ownership:

- Put Better Auth tables in a dedicated `auth` schema and keep Shelf domain tables in Shelf's existing schema.
- Give Better Auth its own `pg.Pool` configuration or a deliberately shared pool, but do not expose Better Auth/Kysely types to `packages/core`.
- Generate Better Auth SQL with the exact pinned package/CLI version, review it, and apply it through an explicit deployment migration step. Do not run auth migrations implicitly when the API process starts.
- Treat a Better Auth upgrade that changes generated SQL as a reviewed application migration. Do not let an `@latest` CLI mutate a production database.
- Keep the mapping from a Better Auth user ID to a Shelf actor explicit, unique, and migration-safe.

These are Shelf operational inferences. Better Auth officially supports SQL generation, direct migration, plugin schemas, PostgreSQL, and non-default schemas, but it does not choose Shelf's release discipline. ([database guide](https://better-auth.com/docs/concepts/database), [PostgreSQL adapter](https://better-auth.com/docs/adapters/postgresql))

## Why not the other candidates?

### Clerk

Verified strengths are substantial: Clerk has an official Fastify plugin that validates session JWTs and attaches user/session/organization state, organization roles and permissions, and user- or organization-owned API keys with scopes, expiry, list/create/revoke APIs, and prebuilt management UI. ([Fastify SDK](https://clerk.com/docs/reference/fastify/overview), [roles and permissions](https://clerk.com/docs/guides/organizations/control-access/roles-and-permissions), [API keys](https://clerk.com/docs/guides/development/machine-auth/api-keys))

The mismatch is the product boundary. Clerk provisions and hosts the production Frontend API and exposes its Backend API for administrative operations. Its API-key feature is billed per creation and verification after included usage. Shelf could not truthfully say that a default installation owns and operates its complete authentication path. ([architecture](https://clerk.com/docs/guides/how-clerk-works/overview), [API-key pricing](https://clerk.com/docs/guides/development/machine-auth/api-keys#pricing))

### Auth.js

Auth.js remains ISC-licensed, self-hosted, data-owning, and capable of database or stateless sessions. Its current official examples foreground Next.js, SvelteKit, Express, and Qwik rather than Fastify. More importantly, the project itself now recommends Better Auth for new projects, while retaining Auth.js for cases such as database-free stateless sessions. Shelf has PostgreSQL and needs broader auth/credential capabilities, so the stated exception does not apply. ([homepage](https://authjs.dev/), [repository and recommendation](https://github.com/nextauthjs/next-auth))

### Stack Auth / Hexclave

The former Stack Auth URLs now redirect to Hexclave documentation and its repository redirects to `hexclave/hexclave`. The root license says clients/examples are generally MIT while server components are generally AGPLv3. Its API-key application supports user and team keys, expiration, create/list/revoke, last-four display, and prebuilt settings UI. ([license](https://github.com/hexclave/hexclave/blob/dev/LICENSE), [API keys](https://docs.hexclave.com/guides/apps/api-keys/overview))

Its official self-host guide describes a separate auth server and dashboard plus PostgreSQL, production cron, a reverse proxy, email, optional Svix, and feature-dependent S3; the current supported Docker path also lists ClickHouse. The guide itself calls the system complex and recommends its cloud for most users. That is a large authentication subsystem beside Shelf's modular monolith and a higher operating floor than Better Auth in-process. ([self-host guide](https://docs.hexclave.com/guides/other/self-host))

### ZITADEL, Keycloak, and Ory

- ZITADEL is a complete external identity platform. It requires PostgreSQL, a supported reverse proxy, setup/init/runtime operations, and a login UI. Machine users can use keys, client credentials, or PATs. The main repository is AGPL-3.0-only with documented Apache/MIT directory exceptions. ([requirements](https://zitadel.com/docs/self-hosting/manage/requirements), [service-account authentication](https://zitadel.com/docs/guides/integrate/zitadel-apis/access-zitadel-apis), [licensing](https://github.com/zitadel/zitadel/blob/main/LICENSING.md))
- Keycloak is Apache-2.0 and provides mature realms, browser identity, service accounts, and OAuth client credentials. It is nevertheless a separately administered Java IAM server, and its service-account tokens do not remove the need for Shelf's workspace authorization and provenance model. ([repository/license](https://github.com/keycloak/keycloak), [service accounts](https://www.keycloak.org/docs/latest/server_admin/#_service_accounts))
- Ory intentionally separates identity (Kratos), OAuth/OIDC (Hydra), and permissions (Keto). Kratos and Hydra have open-source cores and self-hosting paths; Hydra supports client credentials. The resulting composition is valuable when Shelf needs to act as or deeply integrate with an identity platform, but it is more services and operational policy than one-owner v1 needs. ([Kratos](https://github.com/ory/kratos), [Hydra](https://www.ory.com/hydra), [Keto](https://github.com/ory/keto))

All three should remain integrable later through standards such as OIDC. None should be a required process in Shelf's default deployment now.

## Recommended first implementation slice

1. Add Better Auth core with PostgreSQL-backed owner sessions behind the existing Fastify `Authenticator`; keep cookie caching off initially so revocation is immediate.
2. Support a controlled first-owner bootstrap and administrative recovery path. Do not enable open public registration by default.
3. Add Shelf-owned human/service actors, opaque access credentials, relational workspace/action grants, expiry, revocation, last-use state, and audit events.
4. Return an access secret only from creation. Store only a one-way digest and a non-secret identifier/prefix; ensure logs, errors, OpenAPI examples, and provenance never contain the raw secret.
5. Preserve the CLI's `Authorization: Bearer` contract. Browser cookies must never be accepted as artifact-viewer credentials across the active-content isolation boundary.
6. Define rotation as an explicit safe workflow: create a replacement with copied/reviewed grants, reveal it once, allow an intentional overlap window, then revoke the old credential. A failed intermediate step must leave the new credential with no excess grant or leave the old credential valid—not silently lock out the operator.
7. Test cross-workspace denial, zero-grant denial, revoked and expired credentials, owner-session revocation, bootstrap replay, secret non-disclosure, restart persistence, and concurrent revoke/use behavior against real PostgreSQL.

Only after this slice should Shelf decide which human login methods to expose beyond the controlled local owner account. Social login, external OIDC, passkeys, invitations, organizations, and team roles can be incremental Better Auth configuration or later product decisions without changing Shelf's actor/grant contract.
