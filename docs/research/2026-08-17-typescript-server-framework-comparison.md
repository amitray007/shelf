# TypeScript server framework comparison for Shelf

**Status:** research note, not a decision
**Date checked:** 2026-08-17
**Scope:** Fastify, Hono, Elysia, NestJS, AdonisJS, Express 5, and Nitro

## Executive read

Shelf should compare frameworks as an API and file-transfer service first, not as a dashboard rendering choice. The load-bearing path is an authenticated, versioned REST API that can ingest files without buffering them, enforce hard limits, stream downloads, publish an OpenAPI contract, shut down cleanly, and remain unsurprising in a self-hosted Node/Docker deployment.

Provisional ranking for that job:

1. **Fastify** — best-balanced default and the only candidate here whose official multipart path directly documents per-part streams, async iteration, and granular limits.
2. **Hono** — smallest credible alternative and excellent to test, but its documented multipart convenience API yields `File` values rather than a part stream; OpenAPI and production structured telemetry require composing ecosystem packages.
3. **AdonisJS** — strongest batteries-included alternative, including testing and OpenTelemetry, but more application framework than Shelf initially needs; its standard upload path streams to temporary disk and its current client contract is source-coupled.
4. **NestJS with FastifyAdapter** — mature lifecycle, dependency injection, testing, and OpenAPI support, but adds substantial framework ceremony; Nest's standard Multer upload module is explicitly incompatible with its Fastify adapter.
5. **Elysia** — excellent schema/type/OpenAPI experience on its preferred Bun runtime, but the convenient multipart path parses the whole form and Node adds an adapter boundary on Shelf's riskiest path.
6. **Express 5** — stable and viable, but Shelf would have to assemble multipart, schema validation, OpenAPI, logging, lifecycle, and testing conventions that Fastify already connects.
7. **Nitro** — useful deployment/server toolkit, not a preferred API spine here; the current v3 line is beta while v2 remains the documented stable release, and its OpenAPI feature is experimental.

This ordering is a **Shelf inference**, not a general framework quality ranking. The only recommended commitment after this comparison is a focused upload/download spike between the top candidates; no production framework selection is recorded by this note.

## What Shelf needs from the server

The product plan makes the following concerns disproportionately important:

- File and folder publication means upload handling must preserve backpressure and enforce limits without reading an arbitrary artifact into application memory.
- Immutable revisions and provenance mean an interrupted upload must not accidentally become a committed revision.
- The dashboard and CLI are independent consumers, so a stable, versioned HTTP/OpenAPI contract matters more than a same-repository TypeScript RPC shortcut.
- Docker-style self-hosting favors a conventional long-running LTS runtime, explicit lifecycle hooks, structured logs, and graceful shutdown.
- Active HTML isolation, storage, durable jobs, and renderer workers remain architectural boundaries outside the web framework. No candidate removes the need to design them.

## Comparison matrix

| Candidate | Upload/download path | Validation and API contract | Lifecycle, observability, tests | Runtime and operations | Shelf read |
|---|---|---|---|---|---|
| **Fastify 5** | Official multipart plugin exposes file streams, async iterators, disk mode, and limits for fields, file size, file count, header pairs, and total parts; replies accept Node and Web streams. | JSON Schema is native to request validation and response serialization; official type providers cover TypeBox, `json-schema-to-ts`, and Zod; official Swagger plugin generates OpenAPI from route schemas. | Encapsulated plugins and request hooks are core concepts; Pino is built in; v5 exposes request tracing through Node diagnostics channels; `inject()` boots plugins and performs fake HTTP requests. | Node 20+; documented Docker binding; explicit LTS policy; MIT and hosted by the OpenJS Foundation. | **Best first spike.** It aligns the file path and public API contract without imposing an application framework. |
| **Hono 4** | Responses use Web streams and the Node adapter exposes raw Node request/response objects. The documented multipart API uses `parseBody()` and returns strings or `File` values; the body-limit middleware either checks `Content-Length` or reads the stream to enforce the limit. | Core validator is deliberately thin; official docs show external validators and OpenAPI middleware. Hono RPC derives a client from the server type graph. | Ordered middleware and global error handling are built in; request ID and a simple logger are built in; OpenTelemetry/Pino are listed as third-party middleware; `app.request()` and `testClient()` provide in-process tests. | Core supports many runtimes; the separate Node server adapter requires Node 20+, documents Docker and graceful shutdown; MIT. | **Lean alternative.** Strong if Web-standard portability is valuable, but large multipart ingest and the exact OpenAPI toolchain need proof. |
| **AdonisJS 7** | The body parser's automatic mode streams uploads to temporary disk and supports total upload/file/field limits; official guidance recommends direct-to-object-storage uploads above 100 MB. | VineJS provides runtime validation. Tuyau generates a typed client from routes, controllers, validators, and transformers; an official 2024 announcement also describes an OpenAPI generator, but current v7 docs emphasize the generated registry rather than a durable OpenAPI-first workflow. | Application and service-provider lifecycle hooks are first-class; Pino logging, request IDs, Japa-based API tests, and an official OpenTelemetry package are documented. | v7 requires Node 24+ and has a documented standalone build plus multi-stage Docker recipe; MIT. | **Cohesive but heavier.** Temp-disk ingest is bounded and safe, yet adds I/O and differs from Shelf's likely server-to-object-store flow. |
| **NestJS 11 + Fastify** | `StreamableFile` supports response streaming on Express and Fastify. Nest's built-in upload module uses Multer and is explicitly not compatible with `FastifyAdapter`; Fastify multipart must therefore be integrated below or beside Nest's standard abstraction. | `@nestjs/swagger` generates OpenAPI from decorators; its CLI plugin can infer some metadata, while runtime validation still uses `class-validator` decorators. | Modules, dependency injection, lifecycle hooks, customizable JSON logging, a testing module, and Supertest integration are first-class. | Node 20+; Fastify 5 is supported; Docker binding is documented; MIT. | **Mature but indirect.** Useful if organizational modularity/DI outweighs the adapter escape hatch and decorator overhead. |
| **Elysia 1.4** | Responses can stream generators or `ReadableStream`s with cancellation. `t.File`/`t.Files` add type/size/count checks, but the implementation calls `request.formData()`; it is not a part-by-part streaming parser. Raw `request.body` is a Web stream. | Route schemas provide runtime validation and inferred TypeScript types; the official OpenAPI plugin generates and exposes a spec; Eden Treaty derives typed clients from the application type. | Plugin scope and lifecycle are explicit; an official OpenTelemetry plugin traces lifecycle and streaming; `app.handle(Request)` and Eden provide excellent in-process tests. | Optimized for Bun. Node is supported through the separate `@elysiajs/node` adapter, which uses `srvx`; MIT. | **Promising, runtime-sensitive.** Bun is the clean path; Node adds an adapter seam precisely where large-body behavior matters. |
| **Express 5** | Requests remain Node `IncomingMessage` readable streams. Multipart requires middleware such as team-maintained Multer; Express has no built-in multipart contract. | Express supplies routing and HTTP helpers, not an integrated runtime-schema/OpenAPI path. Those conventions and dependencies are application choices. | Promise rejection forwarding is improved in v5, and middleware is simple; structured logging, tracing, lifecycle composition, and test injection are not integrated core facilities. | Node 18+; conventional Node/Docker fit; v5 receives ongoing support; MIT. | **Useful baseline, weakest leverage.** Its simplicity moves integration work into Shelf rather than eliminating it. |
| **Nitro v2/v3** | H3 exposes the raw Web request stream and has a pull-based body-size guard. Form helpers return parsed `FormData`; no official part-by-part multipart-to-storage path was found. | H3 accepts Standard Schema validators, but Nitro's OpenAPI feature is experimental and uses separately-authored route metadata. | Plugins provide request/response/error/close hooks and shutdown can await `event.waitUntil`; official docs do not present a comparable first-party application test harness or general OpenTelemetry recipe. | v2 is the documented stable line; v3 is beta. Nitro builds standalone Node output and many deployment presets; MIT. | **Exclude as the initial API spine.** Deployment portability is not Shelf's current uncertainty, and Nitro does not solve its storage/API contract problems. |

## Candidate details

### 1. Fastify

#### Verified framework facts

- Fastify's current reference describes validation/serialization, plugins, encapsulation, hooks, lifecycle, and logging as core APIs. The npm registry reported version 5.12.0 and an MIT license when this note was checked. ([reference](https://fastify.dev/docs/latest/Reference/), [package metadata](https://www.npmjs.com/package/fastify))
- Fastify 5 requires Node 20 or newer. The project publishes a formal LTS schedule; Fastify 5's end-of-LTS date is currently listed as TBD. ([v5 migration guide](https://fastify.dev/docs/v5.10.x/Guides/Migration-Guide-V5/), [LTS policy](https://github.com/fastify/fastify/blob/main/docs/Reference/LTS.md))
- `@fastify/multipart` supports async iteration, direct file streams, temporary-disk mode, and in-memory mode. It exposes limits for field-name size, field size/count, file size/count, header pairs, and total parts. Its defaults include 1 MiB per file and 1,000 parts, so Shelf must override them deliberately. It also warns that every file stream must be consumed and reports truncation/limit errors. ([multipart plugin](https://github.com/fastify/fastify-multipart))
- Fastify replies accept Node streams and Web `ReadableStream`s. The documentation warns that streams are treated as pre-serialized, so Shelf must set appropriate content type and error handling before sending. ([reply API](https://fastify.dev/docs/latest/Reference/Reply/))
- Route JSON Schemas drive runtime request validation and response serialization. Official type-provider documentation covers TypeBox, `json-schema-to-ts`, and Zod integrations. ([validation and serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/), [type providers](https://fastify.dev/docs/latest/Reference/Type-Providers/))
- The official Swagger plugin generates OpenAPI 2 or 3 documents dynamically from route schemas, or serves a static specification. It must be registered before routes for route discovery. ([`@fastify/swagger`](https://github.com/fastify/fastify-swagger))
- Pino-backed logging and request IDs are built in. Fastify 5 also exposes request handler tracing through Node's diagnostics-channel API. ([logging](https://fastify.dev/docs/latest/Reference/Logging/), [v5 diagnostics channels](https://fastify.dev/docs/v5.10.x/Guides/Migration-Guide-V5/#diagnostic-channel-support))
- `fastify.inject()` waits for registered plugins and exercises the application without opening a network port. Container documentation explicitly calls out binding to `0.0.0.0`. ([testing](https://fastify.dev/docs/v5.7.x/Guides/Testing/), [server API](https://fastify.dev/docs/latest/Reference/Server/))
- Fastify is an OpenJS Foundation at-large project and MIT licensed. ([repository](https://github.com/fastify/fastify))

#### Shelf inference

Fastify is the lowest-risk fit because its default abstractions line up with Shelf's two hardest boundaries: streamed multipart ingestion and an independently consumable OpenAPI contract. A schema-first route module can generate dashboard/CLI clients while keeping HTTP—not imported server types—the compatibility boundary.

The main implementation discipline is to keep domain commits after object storage success, configure non-default upload limits, and prove abort cleanup. Fastify supplies the transport primitives; it does not supply those invariants.

### 2. Hono

#### Verified framework facts

- Hono is a Web-Standards-based, multi-runtime TypeScript framework. The npm registry reported version 4.13.2, Node `>=16.9.0` for core, and MIT when this note was checked; the separate Node adapter requires Node 20 or newer. ([overview](https://hono.dev/docs), [core metadata](https://www.npmjs.com/package/hono), [Node adapter metadata](https://github.com/honojs/node-server/blob/main/package.json))
- The Node adapter documents Docker operation, graceful shutdown, and access to the underlying Node `IncomingMessage` and `ServerResponse`. ([Node adapter](https://hono.dev/docs/getting-started/nodejs))
- Hono's streaming helper creates Web-stream responses. Its documented multipart parsing path is `c.req.parseBody()`, which returns string or `File` values, including arrays when requested. ([streaming helper](https://hono.dev/docs/helpers/streaming), [request `parseBody`](https://hono.dev/docs/api/request#parsebody))
- The body-limit middleware checks `Content-Length` when present and otherwise reads the body stream to count bytes before invoking the handler. ([body limit](https://hono.dev/docs/middleware/builtin/body-limit))
- Hono's core validator performs the callback supplied by the application; official guidance shows external validator middleware. The official examples include `@hono/zod-openapi` and `hono-openapi`, rather than a core schema/OpenAPI facility. ([validation](https://hono.dev/docs/guides/validation), [Zod OpenAPI example](https://hono.dev/examples/zod-openapi), [Standard Schema OpenAPI example](https://hono.dev/examples/hono-openapi))
- Hono RPC derives `hc` client types from `typeof app`. The documentation calls for strict mode, recommends a monorepo, describes possible type-instantiation slowdowns for large applications, and notes that global error responses are not inferred. ([RPC guide](https://hono.dev/docs/guides/rpc))
- Middleware ordering and error handling are documented. A request-ID middleware and simple text logger are built in; the official catalog lists Pino and OpenTelemetry integrations as third-party middleware. ([middleware](https://hono.dev/docs/guides/middleware), [request ID](https://hono.dev/docs/middleware/builtin/request-id), [logger](https://hono.dev/docs/middleware/builtin/logger), [third-party middleware](https://hono.dev/docs/middleware/third-party))
- `app.request()` accepts Web `Request`s and returns `Response`s for tests; `testClient()` provides type-safe route calls but requires chained route definitions for full inference. ([testing guide](https://hono.dev/docs/guides/testing), [testing helper](https://hono.dev/docs/helpers/testing))

#### Shelf inference

Hono is compelling if the team values a very small Web-standard core and may later target runtimes beyond Node. For Shelf today, that portability is less valuable than a proven large multipart path. The documented high-level multipart API materializes `File` values, and the non-`Content-Length` limit path consumes the stream before the handler. A custom parser or Node-level integration may solve this, but should not be assumed.

Hono RPC is useful inside the monorepo, but it should not be the published CLI contract: external CLI releases and non-TypeScript clients need a versioned OpenAPI/HTTP boundary that outlives the server's inferred type graph.

### 3. AdonisJS

#### Verified framework facts

- AdonisJS 7 shipped on 2026-02-25, updated more than 45 official packages, and requires Node 24 or newer. The core repository is MIT licensed. ([v7 announcement](https://adonisjs.com/blog/v7), [v6-to-v7 guide](https://docs.adonisjs.com/v6-to-v7), [core repository](https://github.com/adonisjs/core))
- Automatic multipart processing streams uploaded files to the operating system's temporary directory; body-parser configuration supports total request limits and per-file/field limits. Routes can opt into manual processing. ([body parser](https://docs.adonisjs.com/guides/basics/body-parser))
- Official file-upload guidance recommends direct client-to-cloud uploads for files larger than 100 MB. ([file uploads](https://docs.adonisjs.com/guides/basics/file-uploads))
- VineJS validators cover request data and uploaded-file attributes. ([validation](https://docs.adonisjs.com/guides/basics/validation))
- Tuyau generates a type-safe client registry from routes, controllers, validators, and transformers. The v7 monorepo setup exports generated backend files for frontend import. A 2024 official announcement describes Tuyau as also providing an OpenAPI generator, but that generator is not foregrounded in the current v7 client guide. ([current API client guide](https://docs.adonisjs.com/guides/frontend/api-client), [Tuyau announcement](https://adonisjs.com/blog/introducing-tuyau))
- Routes can be grouped and prefixed explicitly for API versions. ([routing](https://docs.adonisjs.com/guides/basics/routing))
- Adonis documents application/service-provider lifecycle, Pino-based structured logging, request IDs, first-party Japa testing support, API tests, and an official OpenTelemetry integration that instruments HTTP, database, and Redis. ([application lifecycle](https://docs.adonisjs.com/guides/concepts/application-lifecycle), [service providers](https://docs.adonisjs.com/guides/concepts/service-providers), [logger](https://docs.adonisjs.com/guides/digging-deeper/logger), [testing](https://docs.adonisjs.com/guides/testing/introduction), [API tests](https://docs.adonisjs.com/guides/testing/api-tests), [OpenTelemetry](https://docs.adonisjs.com/guides/digging-deeper/opentelemetry))
- Deployment documentation covers a standalone production build and multi-stage Docker image. ([deployment](https://docs.adonisjs.com/deployment))

#### Shelf inference

Adonis is credible when cohesion and conventions are worth more than a small dependency surface. Its temp-disk upload path is safer than buffering, but it adds disk capacity and cleanup concerns and does not establish direct server-to-S3 streaming. The recommendation for direct browser uploads above 100 MB also needs reconciliation with Shelf's agent CLI, provenance, and atomic revision workflow.

The current Tuyau registry is excellent monorepo ergonomics but source-coupled. Shelf would still want a checked-in/generated OpenAPI artifact as the compatibility contract. Confirm the supported Adonis 7 OpenAPI-generation path before choosing it.

### 4. NestJS with FastifyAdapter

#### Verified framework facts

- Nest 11 requires Node 20 or newer and supports Fastify 5 through `FastifyAdapter`. Nest uses Express by default and notes that Express-specific packages may need Fastify equivalents when the adapter changes. ([migration guide](https://docs.nestjs.com/migration-guide), [Fastify adapter](https://docs.nestjs.com/techniques/performance))
- Nest's standard file-upload module is based on Multer and explicitly says it is not compatible with `FastifyAdapter`. `StreamableFile` supports response streaming on both Express and Fastify. ([file upload](https://docs.nestjs.com/techniques/file-upload), [streaming files](https://docs.nestjs.com/techniques/streaming-files))
- The native adapter instance remains accessible when platform-specific behavior is required. ([HTTP adapter](https://docs.nestjs.com/faq/http-adapter))
- `@nestjs/swagger` generates OpenAPI documents. The Swagger CLI plugin can derive decorator metadata, but the documentation separately requires `class-validator` decorators for runtime validation. ([OpenAPI](https://docs.nestjs.com/openapi/introduction), [Swagger CLI plugin](https://docs.nestjs.com/openapi/cli-plugin))
- Nest documents application/module lifecycle hooks, configurable text or JSON logging, dependency-injected testing modules, and Supertest-based end-to-end tests. ([lifecycle](https://docs.nestjs.com/fundamentals/lifecycle-events), [logger](https://docs.nestjs.com/techniques/logger), [testing](https://docs.nestjs.com/fundamentals/testing))
- The npm registry reported version 11.2.1, Node 20+, and MIT when this note was checked. ([package metadata](https://www.npmjs.com/package/@nestjs/core))

#### Shelf inference

Nest is operationally mature, but the framework adapter becomes visible exactly on uploads. Shelf would either integrate `@fastify/multipart` as platform-specific infrastructure or build a custom abstraction, while also maintaining Nest decorators and validation conventions. That cost is justified for a large team or many independently owned modules, not yet by a one-owner first release.

### 5. Elysia

#### Verified framework facts

- Elysia describes itself as optimized for Bun while supporting multiple runtimes. Current releases show 1.4.x; the project is MIT licensed. Node deployment requires the separate `@elysiajs/node` adapter, which uses `srvx`. ([quick start](https://elysiajs.com/quick-start), [Node integration](https://elysiajs.com/integrations/node), [releases](https://github.com/elysiajs/elysia/releases), [Node adapter source](https://github.com/elysiajs/node/blob/9e453cbe6b505cd744efcb8e18f2c5c7a0f93f72/src/index.ts))
- Route schemas validate request/response/query/header/cookie data at runtime and infer TypeScript types. The official OpenAPI plugin derives and exposes an OpenAPI document. ([validation](https://elysiajs.com/essential/validation), [OpenAPI patterns](https://elysiajs.com/patterns/openapi), [OpenAPI plugin](https://elysiajs.com/plugins/openapi))
- `t.File` and `t.Files` support file type, size, and count constraints. The Web-standard adapter implementation calls `request.formData()` before normalizing file values, so this documented convenience path is whole-form parsing rather than a part stream. The raw request body remains a Web `ReadableStream`. ([validation](https://elysiajs.com/essential/validation), [handler/request body](https://elysiajs.com/essential/handler), [adapter implementation](https://github.com/elysiajs/elysia/blob/89088df74b2fc0bbb01df34c6a0f78d1d1e3e974/src/adapter/web-standard/index.ts#L42-L48))
- Bun configuration exposes a maximum request-body size with a documented 128 MiB default. The Node adapter forwards server options to `srvx`; `srvx` documents pull-based streaming body limits, but Elysia's Node integration page does not state that contract directly. ([configuration](https://elysiajs.com/patterns/configuration), [`srvx` options](https://srvx.h3.dev/guide/options), [`srvx` body limit](https://srvx.h3.dev/guide/body-limit))
- Elysia streams generators/Web streams with cancellation, has explicit local/scoped/global plugin semantics, provides an OpenTelemetry plugin, and supports in-process `app.handle(Request)` tests. Eden Treaty offers in-process and network type-safe clients derived from the app type. ([handlers](https://elysiajs.com/essential/handler), [plugins](https://elysiajs.com/essential/plugin), [OpenTelemetry](https://elysiajs.com/patterns/opentelemetry), [unit tests](https://elysiajs.com/patterns/unit-test), [Eden](https://elysiajs.com/eden/overview))

#### Shelf inference

Elysia's schema ergonomics are among the strongest candidates, but `t.Files` is not evidence of safe large-file streaming. Choosing Bun would add a runtime decision; choosing Node would add an adapter boundary. Either way, the raw upload-to-object-store path, cancellation, unknown/chunked lengths, and 413 behavior need a spike before considering it for Shelf.

Eden can accelerate an internal dashboard or TypeScript CLI, but OpenAPI/HTTP should remain the durable public contract rather than Elysia's route-type graph.

### 6. Express 5

#### Verified framework facts

- Express 5.2.1 package metadata requires Node 18+ and uses the MIT license. The official support page lists the v5 line as ongoing. ([package metadata](https://github.com/expressjs/express/blob/master/package.json), [support](https://expressjs.com/en/support/))
- Express 5 forwards rejected promises from middleware/handlers to error middleware. ([v5 release](https://expressjs.com/en/blog/2024/10/15-v5-release/), [middleware](https://expressjs.com/en/5x/guide/writing-middleware/))
- Express request objects extend Node's request object; Node's `IncomingMessage` is a readable stream. ([Express request API](https://expressjs.com/en/5x/api/request/), [Node HTTP API](https://nodejs.org/api/http.html#class-httpincomingmessage))
- The Express team lists Multer as its maintained multipart middleware. Multipart, runtime schema validation, OpenAPI generation, structured logging, and tracing are not core Express facilities in the documented API. ([middleware catalog](https://expressjs.com/en/resources/middleware/), [Express 5 API](https://expressjs.com/en/5x/api.html))
- If an error occurs after response headers have been sent, the default Express error handler closes the connection. This matters for download-stream error design. ([error handling](https://expressjs.com/en/5x/guide/error-handling/))

#### Shelf inference

Express remains a dependable low-level baseline, but “minimal framework” does not produce a minimal Shelf system: the application would own more integration policy and compatibility glue. Direct Node streams are useful, yet Fastify preserves that capability while providing schema, lifecycle, logging, testing, and official multipart/OpenAPI paths.

### 7. Nitro

#### Verified framework facts

- Nitro's current main/v3 package is a 3.0 beta and requires Node `^20.19 || >=22.12`; its README explicitly identifies v2 as the current stable release. The v2 branch currently reports the `nitropack` 2.13.x line. Both are MIT licensed. ([repository/readme](https://github.com/nitrojs/nitro), [releases](https://github.com/nitrojs/nitro/releases), [v2 branch](https://github.com/nitrojs/nitro/tree/v2), [v3 package metadata](https://github.com/nitrojs/nitro/blob/main/package.json))
- Nitro is a Vite-based server toolkit and deployment compiler. It supports file/programmatic H3 routes and custom server entries for H3, Hono, Elysia, Express, or Fastify applications. ([routing](https://nitro.build/docs/routing), [server entry](https://nitro.build/docs/server-entry))
- Its default Node production preset creates standalone output; Node cluster/middleware and many hosted deployment presets are also documented. ([deployment](https://nitro.build/deploy), [Node runtime](https://nitro.build/deploy/runtimes/node))
- H3 exposes the raw Web request body and a pull-based `assertBodySize` guard that handles missing or dishonest `Content-Length`. Its form helpers parse to `FormData`; no official part-by-part multipart-to-storage API was found. ([H3 request utilities](https://h3.dev/utils/request), [`srvx` body limit](https://srvx.h3.dev/guide/body-limit))
- H3 request readers accept Standard Schema validators. Nitro's OpenAPI support is marked experimental and consumes explicit OpenAPI route metadata rather than deriving the contract from those validators. ([H3 validation](https://h3.dev/utils/request), [Nitro OpenAPI](https://nitro.build/docs/openapi))
- Nitro plugins expose request, response, error, and close hooks; graceful shutdown awaits work registered with `event.waitUntil`. ([plugins](https://nitro.build/docs/plugins), [lifecycle](https://nitro.build/docs/lifecycle))

#### Shelf inference

Nitro solves deployment-target packaging and Vite/server integration, not Shelf's central upload, storage, revision, or API-contract risks. Its v2-stable/v3-beta split adds avoidable selection uncertainty. It should not be the first API framework choice. A stable REST server could still be hosted behind Nitro later if broad deployment presets become a demonstrated requirement.

## Cross-cutting conclusions

### Streaming is not one capability

The candidates expose three materially different upload shapes:

1. **Part stream:** Fastify's official multipart plugin yields each file as a stream and enforces multipart-specific limits.
2. **Temporary file:** Adonis streams to local temporary storage before application processing.
3. **Materialized form/file:** Hono's documented `parseBody()` and Elysia's standard multipart path produce `File`/`FormData` values. A raw body stream may exist, but parsing multipart boundaries safely then becomes additional infrastructure.

Nest depends on its selected HTTP adapter and upload integration. Express exposes raw Node streams but delegates multipart parsing. Nitro/H3 preserves the raw Web stream and total-body limiter but does not document a part-by-part multipart storage path.

For Shelf, download streaming is necessary but not discriminating: all candidates can ultimately return or pipe a stream. Upload aborts, truncation, per-part limits, cleanup, and atomic revision creation are the meaningful spike.

### Shared TypeScript types are not API versioning

Hono RPC, Elysia Eden, and Adonis Tuyau are useful compile-time conveniences, especially for the dashboard. They couple the client build to a server route/type graph and do not by themselves define wire-level compatibility for separately released CLI versions or non-TypeScript clients.

Shelf should treat a generated, testable OpenAPI document and explicit `/api/v1` routes as the durable boundary. A generated TypeScript client may consume that contract. This conclusion favors Fastify's schema-to-OpenAPI path, while leaving room for the other frameworks if their OpenAPI setup is made equally authoritative.

### Background work remains separate

Lifecycle hooks can initialize and close a queue client; they do not make in-process promises durable. Preview generation, archive creation, retention cleanup, and import/export should eventually run from persisted job state with idempotent handlers. This is a Shelf architectural inference common to every candidate, not a framework feature comparison.

## Risks and uncertainties worth spiking

Only the following questions are likely to change the ranking:

1. **Fastify streamed ingest:** stream a multipart file directly into the selected S3-compatible client while computing a digest; enforce byte/file/part limits; abort the object write and leave no revision on disconnect or checksum failure.
2. **Hono alternative:** prove whether a maintained multipart parser can consume `Request.body`/the Node raw request part-by-part without `parseBody()` materialization, and how limits behave for chunked bodies.
3. **Elysia runtime choice:** run the same test on Bun and `@elysiajs/node`, including unknown `Content-Length`, disconnect cancellation, and 413 behavior. Do not use `t.Files` for this test.
4. **Adonis storage path:** quantify temp-disk use and cleanup, or prove a supported manual direct-to-object-store route; verify the supported Adonis 7 OpenAPI generator and whether the resulting spec can be CI-checked.
5. **Nest escape hatch:** if Nest remains attractive, build one Fastify multipart endpoint inside Nest and confirm hooks, errors, OpenAPI, tests, and graceful shutdown remain coherent.

## Suggested decision sequence

This note does not select a framework. The smallest next comparison is:

1. Use the same contract fixture for Fastify and one challenger (Hono if minimalism is the priority; Adonis if batteries-included cohesion is the priority).
2. Test a 1-byte file, a moderately large file, a deliberately over-limit file, a multipart folder batch, a client disconnect, and a streamed download with range/conditional headers if those are in the first API slice.
3. Generate an OpenAPI document and a standalone CLI client from it; verify an older client fixture remains compatible after an additive API change.
4. Compare code, memory/disk behavior, cleanup guarantees, and operator-visible logs—not synthetic request throughput.

That spike can resolve the framework decision without prematurely selecting authentication, the database mapper, queue, renderer architecture, or final deployment topology.
