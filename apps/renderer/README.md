# Shelf renderer boundary

`@shelf/renderer` is a separate-origin Fastify service for one deliberately narrow case:
`text/html` shared artifacts. It receives a share capability only through a parent-owned form POST
and never receives Shelf cookies or authentication credentials. For HTML inside a folder artifact,
it redirects the frame to a revision-scoped folder session so the browser can load sibling files.

## Browser contract

- `GET /` is an inert availability document. It does not accept a capability.
- `POST /render` accepts `nonce` plus either `shareId` and `viewerToken` or `publicCode`, with an
  optional folder `path`, `revisionId`, and link `fragment`, as `application/x-www-form-urlencoded` body fields from
  the iframe's opaque sandbox origin. A
  sandboxed form navigation reports `Origin: null`; missing, cookie-bearing, application-origin,
  and other-origin requests are rejected. The capability is the request authority, and a dedicated
  renderer hostname keeps Shelf session cookies out of the request.
- The parent targets a transient form at an iframe with `sandbox="allow-scripts"`, an empty
  Permissions Policy, a no-referrer policy, and a credentialless browsing context. The iframe
  must not grant same-origin, forms, popups, downloads, or top-navigation.
- Before authored scripts, the renderer creates an in-memory random channel, sends a nonce-bound
  `armed` message, and registers the matching `ready` or `unavailable` message for `window.load`.
  Authored markup can read neither the closure-held channel nor a completed message. The parent
  validates the iframe window, submitted nonce, private channel, and the sandboxed sender's `null`
  browser origin.
- The parent submits only after the iframe's initial blank load, keeps the frame hidden until
  `ready`, blanks a response that loads without completing the private handshake, and immediately
  blanks every later iframe load. Renderer data-plane work also has a finite request timeout.

The final artifact response blocks fetch/connect, forms, nested frames, workers, object content,
and base URLs. External subresources are blocked unless the operator configures trusted resource
origins as described below. Inline and `data:` scripts, inline styles, and data/blob media are
allowed. Every response is `no-store`, `no-transform`, `no-referrer`, `nosniff`, and denies browser permissions. `no-transform` also
prevents a CDN from injecting scripts into the isolated document.

## Folder sessions

A render request with a folder `path` that names an HTML file answers `303 See Other` to
`/f/<session>/<path>`. The session is an HMAC-signed token, derived from the share-signing key, that
names the share authority, one exact revision, the parent nonce, and an expiry of at most one hour.
A Protected session never outlives its viewer session. A Latest share is pinned to the revision
that was current when the session started, and an open session keeps reading that revision after a
newer one is published.

- `GET /f/<session>/<path>` with `Sec-Fetch-Dest: iframe`, or with no `Sec-Fetch-Dest` for an HTML
  file, returns that HTML file as the document. Its
  CSP allows scripts, styles, images, fonts, media, and `connect-src` only from
  `https://<Host>/f/<session>/` and `http://<Host>/f/<session>/`. External origins and other
  sessions stay blocked. A path that ends in `/` serves that directory's `index.html`.
- Any other destination returns the file bytes with the stored media type, `nosniff`, a
  `default-src 'none'; sandbox` CSP, `Access-Control-Allow-Origin: *` for module scripts, fonts,
  and `fetch()` from the opaque sandbox origin, and one optional byte range. Error responses carry
  the same CORS header, so scripts can read a 404. The body streams outside the handler deadline,
  which bounds only the lookup. Query strings are ignored, so `app.js?v=2` reads `app.js`.
- The route rejects top-level document requests, cookies, foreign `Origin` values, invalid or
  expired sessions, encoded slashes, and paths outside the folder. Every request resolves the
  share again, so revocation and expiry apply at once.
- Exact Public preview URLs for the active share on the application origin, which older folder
  HTML used to reach sibling files, are rewritten to the matching session path.

The injected handshake script handles link clicks. A same-document fragment link updates history
and scrolls without a navigation, because WebKit fires a frame load for fragment navigation. In a
folder session, a link to another file in the session posts `shelf:renderer-open-path` with the
file path and the link's fragment on the private channel. A directory link names its
`index.html`. The parent viewer selects that file and sends the fragment as the render request's
`fragment` field, which the session redirect appends to its `Location`. The parent still terminates every later
frame load. Root-relative references such as `/assets/app.js` resolve outside the session and stay
blocked.

## Trusted CDN resources

The installation owner can open **Settings > HTML previews** in the dashboard and edit
**Trusted asset sources**. The list allows external scripts, module imports, stylesheets, images,
fonts, and media in standalone HTML previews across all workspaces. Save an empty list to block
external assets. Saved changes apply when a preview opens or reloads, without a renderer restart.
They do not stop scripts already running in an open preview.

Before the first dashboard save, `SHELF_RENDERER_TRUSTED_RESOURCE_ORIGINS` supplies deployment
defaults. Set the same value on the API and renderer processes:

```sh
SHELF_RENDERER_TRUSTED_RESOURCE_ORIGINS=https://cdn.shopify.com
```

Separate environment entries with spaces or commas. Empty or unset blocks external resources
until the owner saves a list. A saved list always overrides the environment, including an empty
saved list. The renderer reads the stored policy for each standalone preview; a failed or invalid
read makes that preview unavailable. Apply migration `0017_html_preview_settings` before startup.
Each entry must be an exact HTTPS origin, with no credentials, path, query, fragment, or wildcard.
The configuration accepts at most 32 entries and 2,048 characters after separating entries.
The application hostname is rejected, including other ports. The renderer excludes its own
request hostname from resource permissions, including other ports, to preserve folder isolation.
The reverse proxy must preserve the browser's `Host` header.

Trust applies to standalone HTML previews, including Protected shares. A permitted script can read
the artifact and send data to permitted origins through resource URLs. A CDN request also discloses
the visitor's IP address. Use only origins you trust with that content. Browser requests go
directly to the CDN; Shelf does not proxy or store these resources. CDN content can change without
a new artifact revision. Bundle dependencies in the folder when an immutable preview is needed.

Folder previews still require bundled assets. CSP skips path matching after redirects, so a CDN
redirect could otherwise load assets from another known folder-session URL. Enabling CDN resources
in folders requires a separate session isolation design; this setting does not enable it.

This setting does not allow external fetch/XHR, frames, workers, forms, popups, or dashboard access.
The sandbox still omits `allow-same-origin`. The dashboard CSP and renderer availability/error
documents do not gain CDN permissions. Libraries that need network APIs or origin storage may
still fail. Folder publish warnings continue to flag external references.

## Known browser limit

A real Chromium probe on 2026-08-18 established the transport and its remaining boundary:

- a parent form can navigate a named `sandbox="allow-scripts"` iframe without `allow-forms`;
- that sandboxed navigation sends `Origin: null`, while the configured application origin remains
  the only allowed frame ancestor and renderer-message recipient;
- a capability stays in the POST body;
- `connect-src 'none'` blocked an authored `fetch` (`0` requests observed);
- authored `location.href` still made one iframe navigation GET (`1` request observed); current
  browsers do not enforce a CSP navigation directive that prevents it.
- with the production renderer response, the observed order was initial iframe `load`, nonce-bound
  handshake, authored-navigation `load`, then parent termination; the frame stayed hidden until
  `ready`, and the parent replaced the navigated frame with `about:blank`.

Consequently this service does **not** claim zero browser egress for arbitrary JavaScript. The
private completion channel prevents a parse-time replacement from remaining active and the
load-gated parent terminates later navigation when it completes. A
strict zero-egress guarantee would require a browser or network sandbox outside CSP and iframe
controls; installations requiring that guarantee must keep HTML download-only.
