# Google Drive storage evaluation for Shelf

**Status:** research note, not a decision
**Date checked:** 2026-08-17
**Scope:** Google Drive as Shelf's authoritative content store versus an optional backup/export destination

## Recommendation

Do **not** use Google Drive as Shelf's primary content store. Also do not currently build an automatic "back up Shelf to Google Drive" integration.

The primary-store recommendation is technical and product-driven: Drive can stream large uploads and serve byte ranges, but it is a user document system with OAuth ownership and sharing semantics, mutable files, Drive-specific quotas, and a proprietary availability boundary. Those constraints are a poor fit for Shelf's authoritative immutable-content layer and its self-hosting promise.

The backup recommendation is more decisive: Google's current Workspace API policy lists "Backup of user or app content from a developer's app or project to Drive" as a disallowed Drive API use case, and separately disallows using Drive as a large-scale CDN. Shelf should not design a first-party integration around a use case Google explicitly says is not allowed. ([Google Workspace API user data and developer policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy))

A user can still download a portable Shelf export and place it in Google Drive with their normal filesystem, browser, or independent backup tooling. That requires no privileged Drive integration in Shelf and preserves Google Drive as one user-controlled copy rather than Shelf's source of truth. If Google later clarifies that a narrowly user-initiated "export one archive to my Drive" flow is permitted, it could be reconsidered as an optional export destination after policy review. It should still not implement Shelf's `ContentStore` port.

## Short answer: is it easy to integrate?

**Mechanically, yes; responsibly as storage for Shelf, no.**

Google exposes a REST API and an officially supported TypeScript/Node client. The client accepts Node readable streams for media uploads and includes OAuth 2.0 and service-account support. Google describes the general API client as complete but in maintenance mode: critical bugs and security issues are addressed, while new features are not expected. ([official Node client](https://github.com/googleapis/google-api-nodejs-client))

The hard part would not be uploading a stream. It would be operating credentials, reconciling two authorization models, maintaining immutability in a mutable document store, handling quota and ownership failures, and staying within Google's API-use policy.

## Verified Google Drive facts

The following are facts from current Google documentation. Shelf conclusions are separated into the next section.

### Upload and download behavior

- Drive supports simple, multipart, and resumable uploads. A resumable upload creates a session URI, reports received bytes through `Range`, returns `308 Resume Incomplete` while incomplete, and requires the client to restart if the session returns `404`. ([upload guide](https://developers.google.com/workspace/drive/api/guides/manage-uploads))
- A simple upload may use chunked transfer encoding without a `Content-Length`. The official Node client accepts a Node readable stream as the media body, so Shelf would not need to buffer an entire file merely to call Drive. ([upload guide](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [official Node client](https://github.com/googleapis/google-api-nodejs-client))
- Blob content is downloaded through `files.get` with `alt=media`. Blob downloads and downloads of retained blob revisions accept a single byte `Range` request. Partial downloads are not supported when exporting Google Workspace documents. ([download guide](https://developers.google.com/workspace/drive/api/guides/manage-downloads), [`files.get`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get))
- Drive exposes output-only MD5, SHA-1, and SHA-256 checksum fields for binary content stored in Drive; those fields are not populated for Docs Editors files or shortcuts. ([file resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/files))
- The API can pre-generate a Drive file ID. Creating a binary file with that ID is retry-safe: after a successful creation, a retry gets `409 Conflict` instead of creating another file. Pre-generated IDs do not generally apply when converting content into Google Workspace formats. ([create-file guide](https://developers.google.com/workspace/drive/api/guides/create-file))
- The reviewed v3 creation documentation does not describe an S3-style `If-None-Match: *` conditional create against an arbitrary caller-selected object key. Pre-generated Drive IDs are the documented no-duplicate retry mechanism. Shelf would still need to store the resulting Drive ID in authoritative metadata rather than treat a file name or folder search as a uniqueness constraint. ([upload guide](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [create-file guide](https://developers.google.com/workspace/drive/api/guides/create-file))

### Drive revisions are not Shelf revisions

- Non-head binary revisions that are not marked `keepForever` are normally purgeable after 30 days and may be purged earlier once 100 purgeable revisions exist. At most 200 revisions of one binary file can be marked `keepForever`. ([revision guide](https://developers.google.com/workspace/drive/api/guides/manage-revisions), [revision resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/revisions))
- Only binary revisions marked `keepForever` can later be downloaded through the revision API. A retained binary revision may be downloaded or permanently deleted. ([revision guide](https://developers.google.com/workspace/drive/api/guides/manage-revisions))
- Drive's file `version` is a server-side monotonically increasing number reflecting every server change, including changes that might not be visible to a user. It is not a Shelf publication ordinal. ([file resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/files))
- Drive content restrictions can discourage modification, but Google explicitly says they are mutable and do not create an immutable record. Users with sufficient permission can also move files or change sharing settings. ([content restrictions](https://developers.google.com/workspace/drive/api/guides/content-restrictions))

### Authentication, ownership, and shared drives

- Long-running user access requires offline OAuth and secure storage of refresh tokens. Google notes several invalidation paths; notably, refresh tokens for external apps left in `Testing` expire after seven days, and one Google Account can have at most 100 refresh tokens per OAuth client before the oldest is invalidated. ([OAuth overview](https://developers.google.com/identity/protocols/oauth2), [web-server OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server))
- The narrow `drive.file` scope is non-sensitive and lets an app manage files it creates or files explicitly shared with it. Broad `drive` and `drive.readonly` scopes are restricted; public apps using restricted scopes require verification, and storing or transmitting restricted-scope data can require a security assessment. ([Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth))
- Several current Google pages say service accounts have no Drive storage quota and cannot receive ownership transfers. The error and shared-drive guides say a service account must write to a shared drive or impersonate a human user through OAuth/domain-wide delegation. Shared-drive support also requires Drive-specific request flags and has a distinct permission model. ([Drive error guide](https://developers.google.com/workspace/drive/api/guides/handle-errors), [shared-drive overview](https://developers.google.com/workspace/drive/api/guides/about-shareddrives), [shared-drive support](https://developers.google.com/workspace/drive/api/guides/enable-shareddrives), [ownership transfer](https://developers.google.com/workspace/drive/api/guides/transfer-file))
- One current create-file page conflicts with those pages by describing "Service Account's dedicated Drive storage." Because other current official pages explicitly say service accounts cannot own files, a production design must not assume service-account-owned My Drive storage without direct Google clarification and an integration test. ([create-file guide](https://developers.google.com/workspace/drive/api/guides/create-file))
- Files in a shared drive are owned by the organization, not an individual. Permissions inherit from parent folders, and shared-drive access is expansive in ways that differ from My Drive. ([shared-drive differences](https://developers.google.com/workspace/drive/api/guides/shared-drives-diffs), [sharing guide](https://developers.google.com/workspace/drive/api/guides/manage-sharing))
- The `appDataFolder` uses a narrow non-sensitive scope and is hidden from the Drive UI, but Google describes it as application-specific configuration storage. It cannot be shared, and the user can delete it directly or by uninstalling the app. ([application data folder](https://developers.google.com/workspace/drive/api/guides/appdata))

### Quotas, limits, and change surface

- Google changed Drive API quotas on 2026-05-01. New projects are measured in quota units with per-project and per-user-per-project minute limits, a 1 TB daily project egress limit, and a stated plan to charge for exceeding request thresholds later in 2026. Google recommends exponential backoff for `403` and `429` rate-limit responses. ([usage limits](https://developers.google.com/workspace/drive/api/guides/limits), [release notes](https://developers.google.com/workspace/drive/release-notes))
- A Google Workspace user may upload at most 750 GB per day across My Drive and shared drives. The documented maximum single-file upload is 5 TB. Reaching the daily threshold can block further uploads or copies for 24 hours. Account and pooled-storage limits still apply. ([usage limits](https://developers.google.com/workspace/drive/api/guides/limits), [`about` resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/about))
- A user can create up to 500 million Drive items. A shared drive has a 500,000-item cap and shared-drive nesting is limited to 100 levels. ([folder limits](https://developers.google.com/workspace/drive/api/guides/folder), [shared-drive management](https://developers.google.com/workspace/drive/api/guides/manage-shareddrives))
- Google publishes Drive API release notes and has changed quotas, permission behavior, limits, and download paths over time. A Drive backend would therefore need ongoing compatibility monitoring rather than being a write-once adapter. ([release notes](https://developers.google.com/workspace/drive/release-notes))

## Shelf inference

### Primary content store: reject

Drive has enough low-level capabilities to pass some of Shelf's storage contract:

- uploads can stream and resume;
- binary reads can stream ranges;
- Drive supplies checksums that Shelf could compare with its own SHA-256;
- pre-generated IDs provide retry-safe create behavior for binary files.

Those strengths do not overcome the mismatches:

1. **The trust model is wrong.** Shelf needs an operator-owned byte store behind Shelf authorization. Drive adds Google accounts, OAuth grants, Drive ownership, inherited ACLs, and user actions that can remove or relocate content independently of Shelf metadata.
2. **Immutability is indirect.** Shelf would need one separate Drive blob per Shelf revision and must never use Drive revisions as its history. Even then, Drive's read-only marker is not an immutable-record guarantee. A privileged Drive user remains able to delete content or alter restrictions.
3. **The failure boundary is larger.** Expired/revoked refresh tokens, Workspace admin policy, deleted users or app-data folders, shared-drive membership changes, storage exhaustion, daily upload limits, egress quotas, `403`/`429` throttling, and API changes can all make valid Shelf metadata point to temporarily or permanently unavailable bytes.
4. **It weakens self-hostability.** A required Google account, Cloud project, OAuth consent configuration, and Google-hosted data plane would violate Shelf's requirement that core publishing and browsing not require a proprietary hosted dependency. An optional provider would not violate that requirement, but it would still need a strong reason to justify its operational surface.
5. **Drive is not a backend CDN.** Every Shelf download would be proxied through a quota-limited Drive API or redirected into Drive's access model. The former conflicts with Google's CDN prohibition at scale; the latter breaks Shelf's stable sharing and authorization boundary.

The correct production filesystem design remains simpler: Shelf owns generated paths, stages locally, seals with a no-clobber filesystem primitive, serves byte ranges directly, and backs up metadata plus immutable bytes through an operator-documented snapshot/export workflow.

### Automatic backup destination: reject under current policy

An automated Drive backup is superficially attractive because many self-hosters already pay for Drive and resumable upload handles large archives. However, the official policy's prohibited-use wording directly describes sending Shelf's app/user content to Drive as backup. Technical feasibility is irrelevant until that policy changes or Google gives written clarification covering Shelf's exact flow.

The `appDataFolder` is not a workaround. It is intended for app-specific data, remains part of Drive, is user-deletable, cannot be shared, and would still make the backup depend on OAuth and Google's policy/availability boundary.

### User-controlled export: keep provider-neutral

Shelf should produce a documented portable archive or manifest through its own export contract. The user can then save or sync that output anywhere, including Drive. This keeps:

- the archive useful with local disks, NAS, S3, Google Drive, and future providers;
- backup credentials outside the Shelf server;
- restore testing independent of a provider API;
- Shelf's portability promise centered on an owned format rather than a hosted integration.

If a future policy review permits a direct user-initiated Drive export, implement it behind an `ExportDestination`, not `ContentStore`. It should upload a complete Shelf archive plus hash manifest as ordinary binary blobs, use a pre-generated Drive ID for retry safety, request the narrowest viable OAuth scope, verify the returned SHA-256 and byte count, and clearly report that Drive retention and availability are outside Shelf. It must never map Shelf versions onto Drive revisions or expose Drive links as Shelf share links.

## Operational failure matrix

| Failure | Primary-store impact | Optional export impact |
|---|---|---|
| Refresh token revoked or expired | Existing revisions may become unreadable. | Export fails; authoritative Shelf content remains intact. |
| User/admin removes Drive access or deletes content | Shelf metadata can reference missing bytes. | A secondary copy is lost without affecting Shelf. |
| Quota or 24-hour upload cap reached | Publishing becomes unavailable despite healthy Shelf infrastructure. | Export can retry later with a bounded backoff policy. |
| `403`/`429` throttling or Google outage | Reads and writes fail together. | Export is delayed; normal publication and reads continue. |
| Permission inheritance changes | Content confidentiality or availability can drift from Shelf policy. | Only the separately exported archive's exposure changes. |
| Partial/resumable session expires | Publish staging must restart and reconcile any remote leftovers. | One export attempt restarts without changing Shelf history. |
| Shelf database restored without matching Drive state | Restore may create dangling revisions or omit remote objects. | The archive is validated as an external restore input. |

## Decision implication

This research does **not** settle T2. It narrows it:

- keep the local filesystem as the simple self-hosted content backend;
- do not add Google Drive to the production `ContentStore` comparison;
- do not implement first-party automated Google Drive backup while current Google policy prohibits the use case;
- make Shelf's export format provider-neutral so users remain free to place exported archives in Drive themselves;
- revisit only if there is demonstrated user demand and current policy clarification, then evaluate a narrow export adapter rather than storage.
