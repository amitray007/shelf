# Shelf desktop mockups (experimental beta)

> Development experiments only. Do not use these mockups as an application or for daily work. The complete HTML files are stored here, including the approved sidebar design in `sidebar.html` and the earlier layout comparison in `index.html`.

Run `python3 docs/mockups/shelf-desktop/serve.py` from the repository root, then open
`http://127.0.0.1:8769`. `PORT` can select another port.

`index.html` is self-contained. It includes the font, styles, sample content, and
interactions. No application data is read or saved.

Switch layouts with the bottom bar or `?variant=A`, `?variant=B`, and `?variant=C`.
The session carries across layouts. Reloading resets it. Use the 80-link option to
compare overflow and search. Workspaces also let you move an artifact between
sections from its viewer toolbar.

The separate-window control simulates the proposed behavior. It does not create
an operating-system window. Artifact rendering and external websites are sample
content; this prototype tests link organization only.

## Sidebar refinement

Open `/sidebar.html` for the selected direction. It has one sidebar, temporary
sections, a permanent Inbox for unsorted links, and an artifact pane. The app has no footer or shared top toolbar.

Press Command-K to search open titles, URLs, and sample document text, paste a
URL, or choose a command. Type `new section`, `move`, or `close`. Drag links
between sections, close a temporary section with its tray button, or use Undo to restore it.
Inbox cannot be collapsed, cleared as a group, or closed. Individual links can
still be closed or moved out.
Command-backslash toggles the sidebar. Related websites appear below their
source artifact.

In the command menu, `Preview a link arriving from another app` adds and selects
a link in Inbox. `Load a busy sample session` adds 40 links.

The design uses Geist dark tokens and typography. The command menu and sidebar
use patterns from [Geist](https://vercel.com/geist/command-menu) and
[beUI](https://beui.dev/components/agents/ai-sidebar). This standalone HTML does
not install beUI React components. Native component selection remains open.

This is an interaction mockup. URLs, artifact rendering, external pages, window
controls, and full screen use sample states. It does not fetch pasted URLs,
handle macOS URL events, or preserve the session after reload.

Validation covered keyboard search and URL entry, duplicate links, section
creation, movement, collapse, close and Undo, incoming links, related pages,
drag events, sidebar collapse, and full screen preview. Drag checks dispatched
DOM events; they were not an operating-system drag test.

## Closing and keyboard shortcuts

An archive-box button on the right closes a link. It appears on hover, keyboard focus,
or the selected row. Right-click a link to move it, or press Shift-F10 while
the row has focus. Middle-click also closes a link. The button does not create
a separate archive; Command-Shift-T restores closed links.

- Command-W closes the current link.
- Command-Shift-T reopens the most recent closed link or section. It does not
  undo moves or remove links opened afterward.
- Command-T, Command-L, and Command-K open the command menu.
- Control-Tab and Control-Shift-Tab select the next or previous link.
- Command-Option-Right/Left and Command-Shift-]/[ also switch links.
- Command-1 through Command-8 select by sidebar order. Command-9 selects the last.
- Command-backslash toggles the sidebar. Command-Shift-M moves the current link.

The host browser can intercept reserved shortcuts in this HTML preview. Shortcut
handlers were checked with DOM keyboard events. A native build must register
window commands and test them while the embedded viewer has focus.

## Home and empty state

Click the Shelf logo to open Home. It lists open links and recently closed work.
It has no statistics or activity charts. Closed items can be reopened directly.

Use `Preview empty state` in Command-K to try first launch. Only the permanent
Inbox remains. Opening the first link leaves Home. Closing the last link returns
to Home with the option to reopen it. Use `Restore sample session` in Command-K
to return to the saved mock session. These preview commands affect sample data only.

Unread links show a blue dot in the same trailing slot as the close button.
Hover or keyboard focus swaps the dot for the archive-box icon without moving
the title. Opening the link clears its unread state.
