# Native viewer feasibility check

This disposable app tests Native SDK 0.10.1 with a native sidebar and one system
WebKit view. It is not the Shelf desktop app or a visual mockup.

Run from the Shelf repository with Node 24 or later:

```sh
./prototypes/native-viewer/run.sh
```

The first run fetches the pinned Native SDK CLI and its verified Zig toolchain.
Generated files stay under `.build/`. Use `run.sh build` for a release binary.

The default page is the public Native SDK site. Set `SHELF_VIEWER_URL` and
`SHELF_VIEWER_ORIGIN` in the environment to load a Shelf installation instead.
Avoid putting protected share URLs in shell history. The prototype does not
persist or print the supplied URL.

The Artifact and Related page buttons navigate one live view. Related page opens
the SDK documentation as a test destination. The native bridge is disabled for
web content. Navigation permits only the supplied Shelf origin and the SDK origin.

This check does not yet implement Switchboard URL receipt, new-window links,
groups, session restoration, multiple windows, or background tab suspension.
Protected links and the full artifact format set still need runtime verification.

On macOS, the release build displayed an existing public Shelf folder, its isolated
HTML preview, and an SVG. Switching between the artifact and the test website
showed a blank interval that remains unresolved. Do not use this experiment for
daily viewing or treat it as a settled framework choice.

The final app scope is Shelf artifacts and pages reached from them. Saved groups
will contain artifact tabs; related pages will retain their artifact association.
Group and tab records must remain separate from live WebKit views.

References: [Native surfaces](https://native-sdk.dev/docs/native-surfaces),
[system WebKit engine](https://native-sdk.dev/docs/web-engines).
