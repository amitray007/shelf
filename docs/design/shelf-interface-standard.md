# Shelf Interface Standard

**Status:** accepted direction for the dark web client

**Updated:** 2026-08-18

Shelf is a dark inspection bench for published artifacts, not a dashboard. The artifact occupies the room; the interface quietly locates it, explains its immutable lineage, and makes sharing or occasional management obvious. The CLI remains the fastest creation path.

## Product shape

- Use one compact application bar for Shelf and workspace scope. Do not add a permanent sidebar for two destinations.
- Artifact detail and public viewer routes use an artifact map bar: workspace, artifact, revision, short hash or target state, and the one primary action.
- The artifact stage is the dominant surface. On desktop, history, provenance, and shares may live in a narrow inspector. On mobile they follow the artifact in reading order or open in a focused sheet.
- Artifacts and credentials are dense ledgers, not card galleries. Use semantic rows, hairlines, and clear columns.
- Empty artifact states continue the CLI workflow with one copyable `shelf publish ... --share` command. Do not invent a dashboard upload flow, metrics, activity, collections, or onboarding art.

## Component policy

Shelf outsources generic component behavior and finish. It owns only product-specific composition and rendering boundaries.

### Managed core

Use Cloudflare Kumo as the single managed component system. Kumo's Base UI substrate owns focus, keyboard, selection, and overlay behavior; its package styles own generic control finish.

Use Kumo for:

- buttons and button links;
- fields, inputs, selects, checkboxes, and radios;
- dialogs, destructive confirmation, menus, popovers, and tooltips;
- badges, banners, empty states, loaders, skeletons, and toast feedback;
- tables, tabs, toolbars, clipboard controls, and code presentation.

Use Phosphor for icons. Default to regular weight and `currentColor`; use fill only for selected state. Icon-only controls require an accessible label.

Do not combine Kumo with HeroUI, Mantine, Radix-based shadcn controls, or beUI equivalents. beUI may be reviewed as source for one isolated motion interaction only after Kumo demonstrably cannot express it.

### Specialist packages

Add a specialist only when it owns a deep accepted behavior, uses Shelf tokens, is isolated behind one adapter, and passes keyboard, reduced-motion, zoom, browser, and bundle checks.

- `remark-gfm` is appropriate for common agent-authored Markdown while raw HTML remains disabled.
- `react-resizable-panels` is appropriate for a desktop artifact/inspector or tree/content split; mobile uses a drawer or reading-order stack.
- `@pierre/trees` remains conditional on a focused 2,000-entry accessibility and stability spike because its current release is beta.
- `@pierre/diffs` remains deferred until Shelf intentionally resolves two text bodies for content-aware comparison. The current comparison contract is structural.
- Do not add a second toast, icon, dialog, tree, or diff implementation.

## Typography

Use Geist Sans for interface language and Geist Mono only for commands, revisions, hashes, IDs, paths, byte counts, and timestamps. Sentence case is the default. Uppercase mono is not a decorative heading style.

| Role | Style |
| --- | --- |
| Utility | 12/16, medium |
| Metadata | 13/18, regular or medium |
| Control and body | 14/20, regular or medium |
| Page title | 20/26, semibold |
| Artifact title | 24–28/32–34, semibold when space permits |
| Machine data | 12/16 Geist Mono with tabular numerals |

## Color and surfaces

Shelf is dark-only. Use semantic roles rather than scattered hex values:

- canvas: the page and viewer background;
- surface: grouped resting content;
- elevated: menus and dialogs only;
- line and strong line: structure and focus-adjacent boundaries;
- ink, muted, and faint: the three text levels;
- action: the single primary action and links;
- proof: success, copied, current, or verified state;
- warning and danger: trust and destructive state.

Use one desaturated action color. Status must include language and must not become a field of colored pills. Lists live on one plane; do not nest rounded cards. Resting groups use at most a small radius, while floating overlays may use a larger one.

## Density and rhythm

- Application and map bars are 48px on desktop.
- Ordinary desktop controls are compact; isolated mobile controls have at least a 44px hit target.
- Consecutive ledger rows use a 40–48px rhythm. Semantic block changes receive 24–32px separation.
- Use spacing based on adjacency: rows stay compact, while preview, provenance, history, and share sections breathe.
- Reveal secondary actions at the point of use. Never make a required mobile action hover-only.

## Motion

Navigation, selection, filters, and keyboard actions are immediate. Motion explains an overlay or a spatial disclosure; it does not decorate data.

- Prefer package behavior and CSS transitions.
- Use opacity and at most 4–6px of transform for 140–200ms with a strong ease-out.
- Preserve correct transform origins and interruption.
- Honor reduced motion.
- Do not add list entrance animation, shimmer by default, magnetic buttons, tilt, shader backgrounds, docks, or shared-element spectacle.

## Responsive rules

- Composition changes without losing capability.
- The map bar compresses to artifact name, revision, and one action.
- Desktop inspector content becomes a disclosure, drawer, or reading-order section.
- Long paths and IDs middle-truncate visually and retain copy/full-value access.
- Layouts must remain operable at 320px and 200% zoom without page-level horizontal overflow.

## Quality gate

Every changed web surface is judged with production-shaped fixtures, not one ideal row. Qualify populated, empty, long-name, folder, multi-revision, active/revoked share, loading, error, and reveal-once states.

Before accepting a UI package or redesign:

1. verify keyboard and focus behavior;
2. run axe with no serious or critical violations;
3. inspect 1440×900, 768×1024, 390×844, and 320×800;
4. verify reduced motion and 200% reflow;
5. run Chromium and WebKit browser paths;
6. measure the production route chunks and confirm unused chart/highlighter code is absent;
7. reject the change if it requires a second visual system or more override CSS than it removes.

## Reference, not imitation

Borrow Vercel's semantic token roles, typography discipline, focus rigor, lowest-necessary elevation, and responsive qualification. Borrow Notion's content-first continuity, adjacency-aware rhythm, and progressive disclosure. Do not reproduce Vercel's pure-black marketing identity or Notion's nested workspace sidebar. Shelf's immutable revisions, provenance, and sharing model must generate the interface structure.

Research supporting this standard:

- [Styled UI package comparison](../research/2026-08-18-styled-ui-package-comparison.md)
- [Artifact UI package comparison](../research/2026-08-18-artifact-ui-package-comparison.md)
- [Web package spike plan](../research/2026-08-18-web-package-spike-plan.md)
- [Vercel Web Interface Guidelines](https://vercel.com/design/guidelines)
- [Notion page design update](https://www.notion.com/blog/updating-the-design-of-notion-pages)
