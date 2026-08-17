# Shelf renderer boundary

`@shelf/renderer` is a separate-origin Fastify service for one deliberately narrow case:
self-contained `text/html` shared artifacts. It receives a share capability only through a
parent-owned form POST and never receives Shelf cookies or authentication credentials.

## Browser contract

- `GET /` is an inert availability document. It does not accept a capability.
- `POST /render` accepts exactly `shareId`, `secret`, and `nonce` as
  `application/x-www-form-urlencoded` body fields from the configured application origin.
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

The final artifact response applies the restrictive CSP directly: no fetch/connect, external
subresources, forms, nested frames, workers, object content, or base URL; only inline scripts and
styles plus embedded data/blob media are allowed. Every response is `no-store`, `no-referrer`,
`nosniff`, and denies browser permissions.

## Known browser limit

A real Chromium probe on 2026-08-18 established the transport and its remaining boundary:

- a parent form can navigate a named `sandbox="allow-scripts"` iframe without `allow-forms`;
- a capability stays in the POST body;
- `connect-src 'none'` blocked an authored `fetch` (`0` requests observed);
- authored `location.href` still made one iframe navigation GET (`1` request observed), including
  with `navigate-to 'none'` present.
- with the production renderer response, the observed order was initial iframe `load`, nonce-bound
  handshake, authored-navigation `load`, then parent termination; the frame stayed hidden until
  `ready`, and the parent replaced the navigated frame with `about:blank`.

Consequently this service does **not** claim zero browser egress for arbitrary JavaScript. The
private completion channel prevents a parse-time replacement from remaining active and the
load-gated parent terminates later navigation when it completes, while `navigate-to 'none'` remains defense in depth. A
strict zero-egress guarantee would require a browser or network sandbox outside CSP and iframe
controls; installations requiring that guarantee must keep HTML download-only.
