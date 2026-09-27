# Shelf Desktop (experimental beta)

> **Development experiments only. Do not use this app for daily work or production.** This is an unfinished, unsupported experimental beta. Behavior and saved session formats may change.

A macOS workspace for Shelf artifacts, being built one component at a time with Native SDK 0.10.1.

## Build, install, and launch

Requires macOS, Xcode command-line tools, Node.js, npm, and Python 3. Native SDK bootstraps its pinned Zig toolchain on the first build.

```sh
./apps/desktop/run.sh
```

The default command builds the app, packages it with a local ad-hoc signature, installs it at `/Applications/Shelf.app`, and launches that copy. It stops the previous installed or repo-local Shelf process before replacing the bundle. If the app cannot stop or the bundle fails verification, installation stops.

The installer checks the bundle identity before replacing an existing app. It keeps the previous installed bundle at `apps/desktop/.build/previous/Shelf.app` and leaves application data unchanged. This is a local development install, without notarization, publication, or a default-browser change.

```sh
./apps/desktop/run.sh bundle   # Build and package without installing
./apps/desktop/run.sh install  # Install and launch the last successful bundle
```

`build` and the existing `dev` alias use the default build/install/launch path. Run the command again after edits to test the updated Applications copy.

## App icon

The canonical logo is `apps/web/public/favicon.svg`. The build renders it with macOS `sips`, preserving its spacing and adding a transparent margin around the tile. Native SDK packages the rendered PNG into the macOS icon. The desktop app uses the same mark as Shelf on the web.

## Workspace

Inbox is permanent and collapsible. New links arrive at its top and open immediately. Empty Inbox and Home states explain how to open a link without adding a search bar or footer.

Use Command-K to search open link titles, URLs, indexed page text, and commands. Paste a URL and press Enter to open it. Choose **New section**, type a name, then press Enter. Sections can be renamed, collapsed, closed, and reordered. Drag links within or between sections and Inbox. Right-click a row for its actions. The tray icon closes a local link; it does not delete a Shelf artifact. An unread dot uses the same trailing position.

The sidebar follows `docs/mockups/shelf-desktop/sidebar.html`, with the tighter desktop spacing: 256 points wide, a 48-point window header, a 40-point identity row, and a 16-point content inset. The wordmark uses outlined Geist at 16 points and weight 600. Inbox uses 13-point medium text; helper text uses 12-point regular text. macOS controls the traffic lights and their fullscreen auto-hide behavior.

| Shortcut | Action |
| --- | --- |
| Command-K | Search links and commands |
| Command-L / Command-T | Open a fresh command search |
| Command-Shift-N | Create a section |
| Command-Shift-M | Move the current link |
| Command-W | Close the current link |
| Command-Shift-T | Reopen the last closed link or section |
| Control-Tab / Control-Shift-Tab | Next / previous link |
| Command-1 through Command-8 | Select a link by sidebar order |
| Command-9 | Select the last link |
| Command-R | Reload |
| Command-[ / Command-] | Back / forward within the current page |
| Command-\ | Toggle sidebar |
| Control-Command-F | Toggle fullscreen |

The right pane shows a loading state while navigation is pending, then reveals the page. Failed loads offer a retry. The viewer uses WKWebView. The eight most recently used pages keep their forms, scroll position, and navigation history in memory. Older pages reload when selected. Shelf's own viewer handles artifact formats and its navigation controls. New-window links and cross-host link clicks become related child rows. HTTPS and loopback HTTP URLs are supported. Page text search indexes content from pages visited during the current run, including embedded frames; it is not a server-wide Shelf search.

Link payloads load from a private SQLite cache in 64-row pages, with neighboring pages buffered for scrolling. Distant titles and URLs leave memory; a small ordering index and the selected link remain resident. Command search reads the disk cache, including text indexed from visited pages. The renderer mounts only nearby rows and lets native scrolling move them between window refills.

The cache is derived from the validated session snapshot and rebuilt at startup. Saving creates a temporary complete snapshot; it does not keep all payloads resident. Set `SHELF_DESKTOP_CACHE_TRACE=1` during an isolated test to print page ranges and resident counts without logging link contents.

## Routing and saved sessions

In Switchboard, route your Shelf hostname to `/Applications/Shelf.app` using its application destination. Keep Switchboard as the default browser. Shelf accepts normal HTTP/HTTPS open-URL events and `shelf://open?url=<percent-encoded-web-url>`.

Links, custom section order, collapsed states, selection, sidebar visibility, and recently closed items are saved atomically to `~/Library/Application Support/Shelf Desktop/session.json`. The directory and file are private to the user. Invalid or unreadable sessions are preserved and never overwritten by a fresh session. Cookies use WebKit's persistent website store. Page content and form values are not written to the session JSON.

For an isolated test session, quit Shelf first, then run:

```sh
open -a /Applications/Shelf.app --env SHELF_DESKTOP_DATA_DIR=/tmp/shelf-desktop-test
```

## Checks

```sh
./apps/desktop/test.sh
```

This runs session invariants and storage checks: move/reorder, close/reopen, snapshot compatibility, capacity limits, URL policy, cold-page eviction and reload, full snapshot preservation, SQLite search, atomic roundtrip, file permissions, and invalid storage handling. The local viewer fixture is in `test/fixtures`.
