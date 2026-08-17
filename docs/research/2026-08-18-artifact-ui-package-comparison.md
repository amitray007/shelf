# Artifact UI package comparison for Shelf

**Status:** research note, not a decision

**Date checked:** 2026-08-18

**Scope:** specialist packages that can replace hand-built artifact UI behavior in Shelf's React 19, Vite 8, Tailwind CSS 4 web application

## Executive recommendation

Shelf should outsource the parts of the interface that are expensive to make genuinely good, while keeping Shelf's product model and visual language source-owned.

The recommended first package set is:

```sh
pnpm --filter @shelf/web add \
  @phosphor-icons/react@2.1.10 \
  sonner@2.0.8 \
  @pierre/trees@1.0.0-beta.6 \
  @pierre/diffs@1.3.5 \
  shiki@4.4.3 \
  react-resizable-panels@4.12.3 \
  remark-gfm@4.0.1
```

This command is a proposed exact-version set, not an action performed by this research note.

Use these packages behind a small number of Shelf-owned adapters:

- `AppIcon` conventions over Phosphor imports;
- `ShelfToaster` and mutation-feedback helpers over Sonner;
- `ArtifactTree` over `@pierre/trees`;
- `SourceView` and later `ContentDiff` over `@pierre/diffs` and Shiki;
- `ArtifactSplitView` over `react-resizable-panels`;
- one Markdown configuration using `react-markdown`, which is already installed, plus `remark-gfm`.

On narrow screens, use the already-installed Base UI Drawer for the folder tree and revision controls. Do not add Vaul. Keep TanStack Table, TanStack Virtual, React Aria Tree, Motion, and `cmdk` deferred until a measured or accepted product need appears.

The important distinction is that installing several focused packages does **not** mean mixing several visual systems. The packages above own behavior. Shelf still owns surface colors, typography, spacing, focus appearance, density, and responsive composition.

## What should be outsourced

| Shelf surface | Package-owned behavior | Shelf-owned responsibility |
|---|---|---|
| App and artifact iconography | SVG geometry, optical weights, React components | one icon family, sizes, color, labels, and when icons are omitted |
| Mutation feedback | toast lifecycle, stacking, promise states, dismissal, live region | message wording, when a toast is appropriate, error recovery |
| Folder browsing | tree model, expansion, focus, keyboard movement, selection, search, virtualization | canonical paths, selected-file routing, change badges, loading/error states |
| Source and code | tokenization, themes, line rendering, large-file worker path | supported languages, byte limits, safe fallback, copy/download actions |
| Content comparison | split/unified rendering, syntax-aware lines, annotations | whether content comparison is permitted and available for the format |
| Desktop tree/content composition | pointer and keyboard resizing, panel constraints, persisted layout callback | breakpoints, default proportions, mobile replacement |
| Markdown | GFM parsing for tables, task lists, strikethrough, and autolinks | raw HTML remains disabled, link/image policy, prose styling |
| Mobile tree/revision controls | Base UI Drawer focus, dismissal, swipe, and modal behavior | information architecture and compact content |

Do not outsource artifact identity, revision targeting, provenance, share trust state, structural change classification, authorization, or renderer isolation to a UI package.

## Install-now matrix

Versions, licenses, declared peer ranges, package contents, and publication timestamps in this section were checked from the npm registry on 2026-08-18. Registry timestamps are activity signals, not guarantees of future maintenance.

| Package | Current snapshot | React 19 / Vite / Tailwind fit | Why Shelf should use it now | Boundary and risk |
|---|---|---|---|---|
| [`@phosphor-icons/react`](https://www.npmjs.com/package/@phosphor-icons/react) | 2.1.10; MIT; published package modified 2025-05-22 | Declares React and React DOM `>=16.8`; plain React SVG components work with Vite and token-driven CSS | One coherent, high-quality icon family for navigation, revision state, sharing, copy, download, and actions. Six weights permit a restrained regular-to-fill state change without inventing custom glyphs. | The package exports more than 9,000 modules and its docs warn that some bundlers eagerly transpile the root export. Use per-icon CSR imports where Vite development performance benefits, never `import * as Icons`, and standardize on regular weight with fill only for true selected state. |
| [`sonner`](https://www.npmjs.com/package/sonner) | 2.0.8; MIT; modified 2026-08-09; about 174 kB unpacked | Declares React 18 or 19 peers. It is styling-library agnostic and exposes CSS/classes for Shelf theming. | Provides polished, compact feedback for rename, copy-link, restore, revoke, and credential actions without building toast timing, stacking, swipe, pause, promise, and dismissal behavior. | Mount one toaster. Keep destructive confirmation in dialogs, keep validation next to its field, and do not toast every navigation. Sonner's current source uses an `aria-live="polite"` region; still verify screen-reader wording and focus behavior in Shelf. ([source](https://github.com/emilkowalski/sonner/blob/main/src/index.tsx)) |
| [`@pierre/trees`](https://www.npmjs.com/package/@pierre/trees) | 1.0.0-beta.6; Apache-2.0; modified 2026-07-25; about 1.46 MB unpacked | Explicitly declares React 18.3 or 19 peers and exports `/react`, `/ssr`, and vanilla entries. Styling is theme/CSS-variable based, so it can sit inside Tailwind-token surfaces. | Replaces the most expensive hand-built Shelf control: a real file tree with path identity, selection/focus separation, keyboard navigation, search, prepared input, density controls, and a virtualized visible row window. This maps directly to R4 and folder comparison browsing. ([documentation](https://trees.software/docs)) | It is still beta and internally depends on Preact 11 beta. Pin the exact version and isolate it behind `ArtifactTree`. Adoption is conditional on the focused spike below passing keyboard, assistive-technology, resize, pagination, and dark-theme checks. Do not expose its model types beyond the web adapter. |
| [`@pierre/diffs`](https://www.npmjs.com/package/@pierre/diffs) | 1.3.5; Apache-2.0; modified 2026-08-07; about 6.93 MB unpacked | Declares React 18.3 or 19 peers; exports React, SSR, edit, and worker entries; official docs include a Vite worker setup. | Outsources professional source-file rendering now and gives Shelf a coherent split/unified content-diff surface later. It supports arbitrary files, patches, line numbers, wrapping, themes, and annotations rather than making Shelf assemble a code viewer line by line. ([documentation](https://diffs.com/docs), [package overview](https://www.npmjs.com/package/@pierre/diffs)) | Shelf's current comparison API is structural: it reports descriptors and added/removed/moved/changed paths, not old/new text. Use the package's file renderer for supported source artifacts now; do not present a line diff until a content-aware adapter is accepted. Lazy-load this route. If a worker is enabled, the docs say Vite may need `worker.format: 'es'`. |
| [`shiki`](https://www.npmjs.com/package/shiki) | 4.4.3; MIT; modified 2026-08-10; about 603 kB for the wrapper package | Framework-independent ESM and compatible with Vite. It is also the tokenizer used by `@pierre/diffs`. | Gives fenced Markdown code blocks the same VS Code-quality token model as standalone source and future diffs. A direct dependency is appropriate if Shelf calls Shiki itself rather than relying on Pierre's transitive dependency. | Do not import the full bundle into the initial app chunk. Shiki documents the full preset as 6.4 MB minified/1.2 MB gzip and the web preset as 3.8 MB/695 kB including async chunks. Use `shiki/core`, one Shelf dark theme, an explicit initial language set, dynamic language imports, and one cached highlighter. ([bundle guide](https://shiki.style/guide/bundles)) |
| [`react-resizable-panels`](https://www.npmjs.com/package/react-resizable-panels) | 4.12.3; MIT; modified 2026-08-16; about 553 kB unpacked | Declares React 18 or 19 peers; TypeScript definitions ship with the package; CSS/classes are consumer-owned. | A folder artifact naturally needs a desktop tree/content split, and comparison naturally needs bounded panes. The library handles pointer resizing, min/max constraints, collapse, and persisted-layout callbacks. | Always render its `Separator`; the official API notes that separators add keyboard accessibility and emit the required WAI-ARIA attributes. Give the hit area a usable coarse-pointer size. Replace the split with Base UI Drawer below the desktop breakpoint rather than squeezing two panes onto mobile. ([repository and API](https://github.com/bvaughn/react-resizable-panels)) |
| [`remark-gfm`](https://www.npmjs.com/package/remark-gfm) | 4.0.1; MIT; modified 2025-02-10; about 22 kB unpacked | Unified/Remark plugin used directly by the already-installed `react-markdown`; no styling-system coupling. | Agent-generated Markdown commonly contains tables, task lists, strikethrough, and autolink literals. This is a small, mature behavior package that prevents Shelf from implementing partial Markdown extensions itself. ([repository](https://github.com/remarkjs/remark-gfm)) | GFM support does not authorize raw HTML. Keep `react-markdown`'s raw-HTML-disabled boundary and Shelf's existing external-link/image policies. |

## Why Phosphor over Lucide

Both options are permissively licensed, React 19 compatible, typed, and tree-shakable.

[`lucide-react`](https://lucide.dev/guide/react) is an excellent default: version 1.31.0 at the check, ISC licensed, actively published, and each icon is a standalone optimized SVG. Its documentation explicitly promises that only statically imported icons enter the final bundle.

[`@phosphor-icons/react`](https://github.com/phosphor-icons/react) is the better Shelf choice because:

- its regular, bold, fill, and duotone variants give file, visibility, pin, and revision states more optical range;
- selected state can change weight without adding a badge or color everywhere;
- its drawing style is less tightly associated with the default shadcn/Lucide dashboard look the redesign is trying to leave behind.

The choice only works if it is disciplined. Shelf should use one default weight, one default size per control density, `currentColor`, and direct imports. Duotone should not become decorative chrome. Lucide should remain the fallback if Phosphor's development import cost is still material after per-icon imports. Do not install both.

Icons do not provide accessible button names. Decorative SVGs should remain hidden from assistive technology and every icon-only control must retain an explicit accessible label and tooltip where discovery benefits.

## File tree: Pierre Trees versus React Aria Tree

### `@pierre/trees`: preferred, conditional install

Pierre Trees is a file-tree product rather than a generic tree primitive. The official guide defines canonical path-based identity, separate focus and selection state, search over the same visible model, keyboard movement over expanded rows, prepared/presorted input, and built-in visible-window virtualization. It also includes density, theming, icon, Git-status/annotation, React, vanilla, and SSR paths. ([official guide](https://trees.software/docs))

This is unusually close to Shelf's requirements:

- Shelf already has canonical relative POSIX paths.
- Folder snapshots have up to 2,000 entries in the accepted initial limits.
- Folder comparison already produces path classifications that can become row annotations.
- The tree must act as navigation, not as a filesystem editor.

The package therefore removes meaningful application code rather than merely moving JSX around.

### React Aria Tree: accessibility-first fallback, not a parallel dependency

[`react-aria-components`](https://www.npmjs.com/package/react-aria-components) 1.20.0 is Apache-2.0, current, React 19 compatible, and exceptionally strong on keyboard, selection, internationalization, async loading, and assistive-technology behavior. React Aria describes Tree as nested-information navigation with keyboard navigation and selection, and supports dynamic collections and load-more rows. ([Tree documentation](https://react-aria.adobe.com/Tree))

It is not the first Shelf choice because it is an unstyled behavioral primitive. Shelf would still need to build file-specific rows, path preparation, icons, expand affordances, density, search integration, virtualization composition, and much of the visual finish. It would also introduce a broad second primitive foundation beside Base UI.

Use React Aria Tree only if the Pierre beta spike fails an accessibility, stability, or theming gate. If selected, use React Aria's own Virtualizer rather than combining Tree with TanStack Virtual; React Aria Virtualizer only mounts visible items while preserving collection behavior. ([Virtualizer documentation](https://react-aria.adobe.com/Virtualizer))

### Required Pierre Trees spike

Before wiring all folder routes, prove one bounded adapter with production-shaped data:

1. Feed 2,000 entries in Shelf's deterministic server order through prepared/presorted input.
2. Verify Up/Down, Left/Right, Home/End, expand/collapse, search, and focus restoration.
3. Verify one selected file remains addressable by canonical path across search and collapse.
4. Render added, removed, moved, and changed annotations without relying on color alone.
5. Verify 320 px, 200% zoom/reflow, coarse pointer, reduced motion, Chromium, and WebKit.
6. Run axe and at least one VoiceOver keyboard pass on the real rendered tree.
7. Confirm the package does not fetch content, infer permissions, or mutate Shelf's immutable snapshot model.
8. Record the route chunk size and scroll responsiveness in a production build.

If this fails, replace only `ArtifactTree`; the rest of the UI should not know which tree engine is underneath.

## Source, Markdown, and diff rendering

### One rendering pipeline, three responsibilities

1. `react-markdown` + `remark-gfm` owns Markdown structure. Raw HTML stays disabled.
2. Shiki owns syntax tokenization for fenced code in Markdown.
3. `@pierre/diffs` owns standalone source/file presentation and, only when the backend permits it, old/new content diffs.

This deliberately avoids adding `react-syntax-highlighter`, Prism, Highlight.js, Monaco, or CodeMirror. Shelf is a viewer, not an editor. One token grammar/theme ecosystem is enough.

### Bundle and worker strategy

- Dynamically import source/diff rendering only for source, JSON, or comparison surfaces.
- Start Shiki with `shiki/core`, one dark theme, and Shelf's actual initial languages: plain text fallback, JSON, JavaScript, TypeScript, JSX/TSX, HTML, CSS, Markdown, shell, YAML, and SQL. Load rarer grammars on demand.
- Cache one highlighter per browser realm; do not create one per code block.
- Keep a plain escaped-text fallback for unknown languages, initialization failure, and content outside the renderer's accepted limits.
- Use the Pierre worker path only after a main-thread production trace shows a reason. The official docs support worker pooling and document Vite as a tested integration, but a worker is still another runtime boundary to test. ([Pierre Diffs documentation](https://diffs.com/docs))

### Structural versus content diff

Shelf's implemented comparison contract identifies descriptor-level changes and pages at most 100 changed paths. That result should initially be rendered as a compact semantic change list or as annotations in `ArtifactTree`. It does not require a generic data grid and it must not be passed to `@pierre/diffs` as though it were a textual patch.

`@pierre/diffs` becomes the content pane only when both old and new supported text bytes are intentionally resolved under Shelf authorization and a content-aware adapter is accepted. Unsupported formats retain the structural result and download/open actions.

## Feedback: Sonner with a strict message policy

Sonner removes more work than Base UI Toast for this phase because it ships the finished stacking and interaction behavior Shelf wants, whereas an unstyled primitive would still require a toast system to be composed and polished.

Use a toast for:

- “Link copied”;
- successful rename, restore-as-latest, share creation, or revocation after the page has already updated;
- a background mutation failure when the affected control is no longer mounted;
- a promise state only when the operation is long enough that persistent feedback is useful.

Do not use a toast for:

- form validation;
- sign-in failure;
- destructive confirmation;
- permanent share target/trust state;
- every successful navigation or file selection;
- an error whose recovery action belongs inline.

The visual adapter should set Shelf's dark colors, radius, type, icon set, and motion behavior rather than accepting Sonner's demo appearance unchanged.

## Desktop panels and mobile sheet

Use `react-resizable-panels` for only two accepted layouts:

- folder tree + file content;
- structural change list + content comparison, when content comparison exists.

Persist the desktop proportion as a local UI preference keyed by workspace/surface, not as artifact metadata. Use explicit min sizes and a visible separator with a larger invisible hit target.

On mobile, use [`@base-ui/react/drawer`](https://base-ui.com/react/components/drawer), already present in Shelf. Base UI's stable Drawer extends Dialog with swipe dismissal, snap points, focus trapping, and optional virtual-keyboard handling. Its own guidance says a positioned Dialog is enough when gestures and snap points are unnecessary.

Do not install [`vaul`](https://github.com/emilkowalski/vaul). Although Vaul 1.1.2 is MIT and declares React 19 compatibility, its repository explicitly states that it is unmaintained, its latest registry publication was in December 2024, and it would also introduce Radix Dialog beside Shelf's Base UI foundation.

## Packages to defer

| Package | Decision | Why not now | Revisit trigger |
|---|---|---|---|
| [`lucide-react`](https://www.npmjs.com/package/lucide-react) | **Do not install alongside Phosphor** | Two icon languages reduce coherence. Lucide is the credible fallback, not a second catalog. | Phosphor direct imports cause unacceptable Vite/build cost or its visual trial fails. |
| [`@tanstack/react-table`](https://tanstack.com/table/latest) | **Defer** | It is a headless state engine, not a high-quality rendered table. Shelf's artifact list and 100-item structural comparison page do not yet need grouping, column state, client sorting, or selection models; adopting it now still leaves all visual and accessibility composition to Shelf. | Accepted dense operational table with user-controlled columns/sorting/filtering and enough rows to justify the state model. |
| [`@tanstack/react-virtual`](https://tanstack.com/virtual/latest/docs/introduction) | **Defer** | Pierre Trees already virtualizes its visible rows. Ordinary artifact and change lists are bounded and simpler without virtualization. TanStack's own Table guide says normal rendering is preferable for small tables. ([guide](https://tanstack.com/table/beta/docs/framework/react/guide/virtualization)) | Production profiling shows a specific non-tree list has too many mounted rows. |
| [`react-aria-components`](https://react-spectrum.adobe.com/react-aria/components.html) | **Fallback only** | Excellent accessible primitives, but a broad second primitive system beside Base UI and more file-tree styling/composition work than Pierre Trees. | Pierre Trees fails the adoption spike, or Shelf later standardizes the entire app on React Aria instead of Base UI. |
| [`motion`](https://www.npmjs.com/package/motion) | **Defer** | Base UI Drawer supplies gesture motion; Sonner owns toast motion; panels own resize interaction; frequent dashboard actions should remain instant. A general animation dependency does not improve the first artifact workflow by itself. | A designed interaction requires interruptible layout/shared-element animation that CSS cannot express cleanly. Then use `motion/react-mini` or `LazyMotion`, not the 34 kB declarative default; Motion documents a 4.6 kB initial LazyMotion path. ([bundle guide](https://motion.dev/docs/react-reduce-bundle-size)) |
| [`cmdk`](https://github.com/dip/cmdk) | **Defer** | Shelf currently has two utility areas and a compact set of artifact actions. A command palette would duplicate visible navigation, add Radix primitives, and create shortcut/documentation obligations without reducing task time. | At least roughly 10 stable cross-page actions or measured keyboard-user demand. Prefer visible shortcuts first. |
| [`vaul`](https://github.com/emilkowalski/vaul) | **Reject for this stack** | Unmaintained and Radix-based while Base UI Drawer is already installed and stable. | None while Base UI remains Shelf's primitive foundation. |

## Package discipline

The user explicitly permits many dependencies, but speed comes from strong boundaries rather than from package count alone:

1. **Pin exact versions.** In particular, never float the Pierre beta.
2. **One package per deep capability.** Do not install parallel tree, diff, icon, toast, or drawer implementations.
3. **Use adapters at package boundaries.** Route components should speak Shelf concepts such as `path`, `revision`, and `changeKind`, not vendor model types.
4. **Lazy-load heavy artifact renderers.** The authenticated artifact catalog and anonymous share shell should not pay for Shiki or diff code until the media type needs it.
5. **Keep unsupported content safe.** A package must not expand T6's render allowlist, bypass active-HTML isolation, or turn download-only content into inline content.
6. **Measure production output.** npm unpacked size is useful for comparing package shape but is not browser transfer size. Record Vite route chunk output after integration.
7. **Test the real rendered medium.** Keyboard, focus, 320 px, 200% reflow, reduced motion, axe, Chromium, and WebKit are release gates for these package-backed surfaces.
8. **Keep escape hatches cheap.** Each specialist package must be replaceable through one adapter without changing API contracts or the product model.

## Suggested implementation order

1. Add Phosphor and Sonner; replace improvised glyphs and mutation notices through the two small adapters.
2. Add `remark-gfm`; keep raw HTML disabled and test artifact-authored tables, task lists, links, images, and fenced code.
3. Build the bounded Pierre Trees spike. If it passes, make it the folder viewer on desktop and inside Base UI Drawer on mobile.
4. Put the folder tree and content behind `react-resizable-panels` on desktop, with one persisted local proportion and explicit keyboard separator.
5. Add a route-lazy `SourceView` using `@pierre/diffs` file rendering. Add direct fine-grained Shiki only for fenced Markdown code.
6. Render the existing structural comparison as tree annotations or a semantic change list. Do not claim line diffs.
7. When a content-aware comparison adapter is accepted, add `ContentDiff` behind the same lazy boundary and choose split or unified view responsively.
8. Run package-license review, production bundle analysis, browser/accessibility QA, and a code review before recording the stack as an accepted T8 update.

## Decision read

The high-leverage change to T8 is not “use unlimited component libraries.” It is:

> Keep Base UI as Shelf's interaction primitive foundation, but adopt focused, permissively licensed specialist packages where they replace a deep artifact behavior: Phosphor for icons, Sonner for feedback, Pierre Trees for folder navigation, Pierre Diffs plus fine-grained Shiki for source/diff rendering, react-resizable-panels for desktop workbench layout, and remark-gfm for expected Markdown structure. Keep every package behind Shelf-owned adapters and lazy-load renderer-heavy routes.

This preserves a coherent dark Shelf interface while materially reducing the amount of tree, code, diff, toast, panel, and Markdown behavior the project must hand-build.
