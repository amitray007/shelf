# Cloudflare R2 storage evaluation for Shelf

**Status:** research note, not a decision
**Date checked:** 2026-08-17
**Scope:** Cloudflare R2 as a remote implementation of Shelf's `ContentStore` and `ContentReader` ports, compared with the supported local-filesystem profile

## Recommendation

Cloudflare R2 is a strong candidate for **Shelf's first officially tested hosted object-storage provider**, behind the same provider-neutral S3 adapter used for other compatible services. It should not be Shelf's universal default and should not become a Cloudflare-specific core abstraction.

Keep the product profiles distinct:

| Deployment profile | Content backend | Recommendation |
|---|---|---|
| Simple, self-contained, single API host | Local filesystem | **Default for the simplest self-hosted installation.** It needs a durable mounted volume, same-filesystem staging/sealing, backups, and explicit single-host limits. |
| Hosted, replica-capable production | S3-compatible object storage | **Reference remote-storage profile.** Multiple Shelf processes can share immutable bytes independently of application disks. |
| First documented hosted provider | Cloudflare R2 | **Officially support after a live conformance gate.** Attractive economics and a small configuration surface, but still a proprietary external dependency. |

R2 should not be merely an aspirational compatibility target: its documented API covers almost all of Shelf's needed operations, and an official provider fixture would give users a practical hosted option. However, do not label it supported until the exact SDK version and a real R2 bucket pass Shelf's no-overwrite multipart, checksum, cancellation, range, and cleanup tests. The current Cloudflare compatibility table explicitly lists conditional `PutObject`, but does not enumerate conditional headers for `CompleteMultipartUpload`; older Cloudflare release notes say conditional multipart publication is supported. That documentation mismatch is important enough to test rather than infer. ([S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [R2 release notes](https://developers.cloudflare.com/r2/platform/release-notes/))

## Fit against Shelf's content contract

Shelf's accepted lifecycle is: consume a stream into private staging, compute SHA-256 and byte count, seal immutable content, then atomically commit metadata that makes the revision visible. A metadata failure may leave an unreachable sealed orphan. R2 fits that model without a distributed transaction because the bucket remains private and only Shelf's metadata exposes a content object.

| Shelf requirement | Verified R2 fact | Shelf conclusion |
|---|---|---|
| Stream without buffering the entire file | Cloudflare documents ordinary and multipart S3 uploads. Multipart is resumable and parallel; a single upload is not resumable. AWS `@aws-sdk/lib-storage` accepts streams of unknown size, bounds concurrency and part size, and aborts multipart state on failure by default. ([R2 uploads](https://developers.cloudflare.com/r2/objects/upload-objects/), [`@aws-sdk/lib-storage`](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-lib-storage/)) | Good fit. Use a bounded multipart configuration and propagate Shelf's cancellation signal into the upload. Do not use `readFile`, `Buffer.concat`, or a whole-object transform in the adapter. |
| Private staging and explicit seal | Multipart parts are not an accessible object until completion. Completed writes are strongly consistent. ([R2 uploads](https://developers.cloudflare.com/r2/objects/upload-objects/), [consistency](https://developers.cloudflare.com/r2/reference/consistency/)) | A random, server-generated staging key can remain unreachable through Shelf until the metadata commit. The adapter may complete the upload during `stage`, then let `seal` validate/adopt the same private object, or explicitly complete an open multipart upload during `seal`. The spike should choose one lifecycle and prove crash cleanup. |
| No overwrite of sealed bytes | R2 documents `If-None-Match` on `PutObject`; failed conditions return `412`. R2 otherwise uses last-writer-wins for concurrent writes to one key. Cloudflare's release history says conditional multipart publication is supported and a failed publish condition aborts the upload, but the current S3 compatibility row for `CompleteMultipartUpload` does not list conditional operations. R2 also offers a proprietary `cf-copy-destination-if-none-match` header for conditional destination copies. ([S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [consistency](https://developers.cloudflare.com/r2/reference/consistency/), [release notes](https://developers.cloudflare.com/r2/platform/release-notes/), [S3 extensions](https://developers.cloudflare.com/r2/api/s3/extensions/)) | **Qualification gate.** Prove two concurrent creators cannot replace the same key for both small and multipart paths. Prefer random 128-bit permanent keys plus conditional creation. Do not emulate exclusivity with `HEAD` followed by an unconditional write. Avoid making the R2-specific conditional-copy header part of Shelf's generic interface. |
| Exact byte integrity | R2 accepts `Content-MD5` for `PutObject`/`UploadPart`; its compatibility page documents supported checksum algorithms and Cloudflare release notes record SHA-1/SHA-256 support for S3 `PutObject`. Multipart ETags are derived from part MD5 values and are not a whole-object SHA-256. ([S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [R2 uploads](https://developers.cloudflare.com/r2/objects/upload-objects/), [release notes](https://developers.cloudflare.com/r2/platform/release-notes/)) | Shelf's own `sha256:` value remains authoritative. Never treat an R2 ETag as the Shelf content hash. The adapter should verify provider-supported transfer checksums where possible, persist Shelf's hash and byte count in PostgreSQL, and test a full read-back/hash path. |
| Full and single-range reads | R2 documents `GetObject`, conditional headers, and byte ranges. Its reads and listings are strongly consistent when made directly through the S3 or Workers API. ([S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/), [consistency](https://developers.cloudflare.com/r2/reference/consistency/)) | Direct fit for `ContentReader.read({ range })`. Use the S3 API, not a cached public/custom-domain URL, for authenticated Shelf reads. Return the SDK's Node stream and ensure it is consumed or destroyed on cancellation. |
| Cleanup after abort/crash | R2 automatically aborts incomplete multipart uploads after seven days by default; lifecycle policy can change the interval. `AbortMultipartUpload` and list-multipart operations are implemented. Lifecycle rules can be prefix-scoped. ([R2 uploads](https://developers.cloudflare.com/r2/objects/upload-objects/), [object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/), [S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)) | Still abort immediately on handled cancellation/failure. Configure and verify an age-based incomplete-multipart rule as a crash backstop. Shelf separately needs an age-gated reconciliation pass for completed objects with no PostgreSQL reference. |
| Multiple API replicas | R2 exposes one network-addressable bucket and provides immediate global read-after-write, delete, metadata, and list consistency. ([consistency](https://developers.cloudflare.com/r2/reference/consistency/)) | Better fit than local files for multiple Shelf API processes. It removes shared-host storage from the API topology, but PostgreSQL remains the authority for visibility and idempotency. |

### Recommended object lifecycle

Use private buckets and opaque, installation-namespaced keys, for example `installations/<installation-id>/content/<random-id>`. The key must not contain a publisher-supplied filename. A cryptographically random permanent key keeps different revisions independent and makes accidental collision negligible; conditional creation remains required as a defense-in-depth invariant.

The cleanest portable approach to spike is:

1. Allocate a random key before consuming the stream.
2. Stream to that key with a conditional create, calculating Shelf's SHA-256 and byte count in the existing core pipeline.
3. On successful provider completion, validate the reported/stored byte count and preserve the provider ETag only as diagnostic metadata.
4. Treat the object as sealed and immutable by adapter contract; never reuse or overwrite its key.
5. Commit the revision and idempotency result in PostgreSQL. A failure here leaves a private sealed orphan for reconciliation.
6. On a pre-seal handled failure, abort multipart state or delete the request-owned object. On a post-seal failure, do not speculatively delete an object that another completed transaction might reference; let reconciliation decide.

If conditional multipart completion cannot be made reliable through the standard SDK path, do not weaken no-overwrite behavior. Options are to inject and sign R2's documented conditional header at the supported multipart phase, use an explicit command sequence rather than the high-level uploader, or keep R2 unsupported until the provider contract can be proven. A stage-then-`CopyObject` design with `cf-copy-destination-if-none-match: *` is a possible R2-only fallback, but adds an extra full-object operation, temporary duplicate storage, and provider-specific logic; it should not define the general adapter.

## Node.js and AWS SDK v3 integration

Cloudflare's current TypeScript example uses the ordinary modular `@aws-sdk/client-s3` package with an account endpoint, explicit credentials, and `region: "auto"`: ([Cloudflare AWS SDK v3 example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/))

```ts
const client = new S3Client({
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  region: 'auto',
  credentials: { accessKeyId, secretAccessKey },
});
```

Jurisdictional buckets require a jurisdiction-specific endpoint, such as `<account>.eu.r2.cloudflarestorage.com`, and clients generally need one endpoint configuration per jurisdiction. ([R2 authentication](https://developers.cloudflare.com/r2/api/tokens/))

Use explicit S3 commands for `HeadObject`, `GetObject`, `DeleteObject`, listing, and multipart lifecycle. Evaluate `@aws-sdk/lib-storage` only after proving it carries Shelf's conditional-create semantics through both its single-`PUT` and multipart branches. Its useful defaults are configurable `queueSize`, minimum-5-MiB `partSize`, and `leavePartsOnError: false`; its convenience is not a reason to obscure seal behavior. ([AWS lib-storage](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-lib-storage/))

Pin the AWS SDK versions and test their emitted requests. Since v3.729.0, the JavaScript SDK automatically calculates CRC32 for uploads unless configured otherwise. Cloudflare's compatibility matrix supports different full-object versus composite checksum combinations, so the conformance test must verify the pinned SDK's default checksum behavior against R2 instead of globally disabling integrity checks by assumption. ([AWS checksum behavior](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-checksums.html), [R2 checksum matrix](https://developers.cloudflare.com/r2/api/s3/api/))

## Limits and operational behavior

Verified current R2 limits relevant to Shelf are: 5 GiB for a single-part upload, approximately 4.995 TiB for multipart, at most 10,000 parts, keys up to 1,024 bytes, metadata up to 8,192 bytes, and at most one write per second to the same object key before higher-rate writes may receive `429`. The documented bucket object count and stored data are unlimited. ([R2 limits](https://developers.cloudflare.com/r2/platform/limits/))

Multipart parts must be 5 MiB to 5 GiB, except the final part may be smaller; all non-final parts must have equal size. ([R2 uploads](https://developers.cloudflare.com/r2/objects/upload-objects/)) Shelf should set its own lower file-size and request limits rather than expose provider maxima as product promises.

R2 is strongly consistent for direct bucket reads, writes, deletes, metadata, and listings. IAM changes are eventually consistent and may take up to a minute. Public/custom-domain caching relaxes content visibility semantics, whereas direct S3 and Workers API calls bypass that cache. ([R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)) Shelf should keep the bucket private and proxy authorized revision reads through its API until the separate share-link and renderer-origin decisions are made.

Cloudflare says R2 is designed for eleven-nines annual durability and returns write success only after data is persisted to disk, while availability has a separate 99.9% SLA. These properties are materially stronger than one local disk, but neither protects against authorized deletion or replaces a tested Shelf backup/export process. ([R2 durability](https://developers.cloudflare.com/r2/reference/durability/))

## Credentials and access boundary

Use a bucket-scoped **Object Read & Write** R2 API token, exposed to Shelf as an access key ID and secret access key. Do not grant account-wide administrative bucket permissions to the application. Cloudflare supports account tokens, user tokens, bucket scoping, and short-lived derived credentials; an account token remains valid until revoked, while a user token becomes inactive if that user is removed. The secret is shown only once in the dashboard. ([R2 authentication](https://developers.cloudflare.com/r2/api/tokens/))

For normal server-side Shelf operation, keep long-lived credentials in the deployment's established secret store and never return them to the CLI or dashboard. Presigned URLs are bearer tokens, can be reused until expiry, and work only on the R2 S3 API domain, not a custom domain. ([R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)) Direct-to-R2 client uploads would broaden the current trusted flow and should remain a separate future design rather than quietly entering the first adapter.

## Cost comparison with local files

As of the check date, R2 Standard costs **$0.015/GB-month**, **$4.50/million Class A operations**, and **$0.36/million Class B operations**. Direct R2 egress is free. The monthly Standard free tier is 10 GB-month, one million Class A operations, and ten million Class B operations. Cloudflare rounds billable usage up to the next billing unit. Multipart initiation, each part upload, completion, and related listing calls are Class A; `GET` and `HEAD` are Class B; delete and abort are free operations. Infrequent Access is cheaper to store but charges retrieval and has a 30-day minimum, so it is not a safe default for revisions whose access pattern is not yet known. ([R2 pricing](https://developers.cloudflare.com/r2/pricing/))

Shelf inference:

- R2 is unusually attractive for shared downloads because egress is not metered, but hot collections with many small reads still incur Class B request costs.
- Multipart raises request cost per publish, especially with small part sizes; choose part size for bounded memory and reliability, then measure rather than optimizing only for request count.
- The local filesystem has no provider request or egress bill, but its real cost includes a durable volume, snapshots, capacity monitoring, replacement, and the inability to freely add API replicas.
- Pricing is external policy, not a Shelf invariant. Document the checked date and never encode today's free tier into product behavior.

## Self-hosting, portability, and lock-in

R2 does **not** make Shelf fully self-contained: the installation needs outbound network access, a Cloudflare account with R2 purchased/enabled, credentials, billing, and tolerance for provider availability and policy changes. Local filesystem storage remains the right default for users whose definition of self-hosting includes control of the data plane.

Lock-in is moderate rather than absent:

- Favorable: Shelf would use an S3-shaped adapter, opaque keys, ordinary object bodies, range reads, and its own PostgreSQL metadata. Cloudflare documents `rclone` and AWS CLI interoperability, which provides straightforward bulk copy paths. ([R2 CLI guidance](https://developers.cloudflare.com/r2/get-started/cli/), [Rclone with R2](https://developers.cloudflare.com/r2/examples/rclone/))
- Constraining: R2 credentials, account endpoints, jurisdictions, pricing, consistency implementation, lifecycle behavior, and `cf-*` conditional-copy extensions are Cloudflare-specific. R2 does not implement all S3 features; notably its compatibility page lists S3 object lock and bucket versioning as unavailable. ([S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/))
- Shelf response: keep provider configuration outside persisted revision records. Store a logical content ID plus backend locator, provide a provider-neutral export manifest containing key, SHA-256, and byte count, and make migration copy-verify-switch-delete rather than in-place mutation. Do not rely on R2 ETags, public URLs, lifecycle rules, or proprietary headers as the only copy of a Shelf invariant.

R2's automatic location is chosen near the bucket creator; location hints are best effort, while EU and FedRAMP jurisdictions enforce residency and use different endpoints. A bucket's jurisdiction cannot later be changed. ([R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)) Shelf deployment documentation should make this an operator choice at bucket creation rather than silently creating buckets.

## Qualification suite before “officially supported”

Run these tests against a real private R2 bucket using the exact pinned SDK versions:

1. Stream an unknown-length 64 MiB input with bounded process memory; verify Shelf SHA-256, byte count, and byte-exact full read-back.
2. Cancel during single upload and each multipart phase; prove handled cleanup and lifecycle-backed cleanup of crash leftovers.
3. Race two conditional single-`PUT` writers for one key; exactly one may create it and the loser must receive a stable precondition failure.
4. Race two multipart uploads for one key, starting both before either completes; exactly one conditional publish may win, and the failed upload must no longer be completable.
5. Simulate a lost completion response, then resolve the result through `HEAD` plus exact Shelf hash/size evidence without overwriting.
6. Read full, first, middle, suffix, and open-ended single ranges; verify exact lengths and bytes. Verify cancellation destroys the response stream.
7. Confirm the pinned AWS SDK's default and explicit checksum modes for single and multipart uploads; never infer SHA-256 from ETag.
8. List and abort incomplete multipart uploads under Shelf's prefix. Verify the configured lifecycle rule independently.
9. Leave a completed object without PostgreSQL metadata, run reconciliation in dry-run and destructive modes, and prove the age gate and fresh database reference check.
10. Run the same behavioral suite against the hardened local-filesystem adapter. Provider-specific setup may differ, but the visible `ContentStore`/`ContentReader` contract must not.

Passing this suite would justify documenting R2 as Shelf's first official hosted provider. Until then, call it a promising R2 conformance target, not a supported backend and not the product default.
