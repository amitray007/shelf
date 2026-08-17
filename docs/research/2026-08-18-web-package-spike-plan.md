# Shelf web package spike plan

Date: 2026-08-18

Status: implementation proposal; no package decision is confirmed by this document

## Recommendation

Run one short, real-screen trial with **Cloudflare Kumo 2.10.0** and choose it unless the trial exposes a concrete blocker. Kumo is the fastest coherent package-first path because it is a managed, pre-styled package built on Base UI, which is already Shelf's only headless primitive. It can replace most generic control styling without making Shelf own another copied component library.

Run **HeroUI 3.2.4** as the bounded comparison only if Kumo fails the visual or bundle checks. Do not install both systems in the same working tree. HeroUI is a credible full replacement, not a companion package.

The governing rule is:

> Package count is not the constraint. Competing primitive, theme, and overlay systems are.

Shelf should own its artifact-specific structure—the thin map bar, artifact preview, revision meaning, and responsive information hierarchy. A managed component package should own buttons, fields, selects, dialogs, menus, badges, tables, clipboard feedback, toasts, tooltips, loading states, and focus/keyboard behavior.

## Current implementation inventory

The web app currently uses React 19.2.8, Vite 8.2.1, React Router 8.3.0, Tailwind CSS 4.3.3, Geist, and `@base-ui/react` 1.6.0.

Observed local implementation cost:

- `apps/web/src/styles.css`: 662 lines.
- Dashboard CSS: 1,451 lines across `shell.css`, `artifact.css`, `access.css`, and `responsive.css`.
- Dashboard and viewer TSX inspected: 1,881 lines.
- Only one package primitive is used directly: Base UI `Dialog` in `dashboard/dialogs.tsx`.
- Buttons, action buttons, links styled as buttons, native selects, fields, checkboxes, radios, status pills, tables/lists, clipboard feedback, empty states, loaders, and icons are otherwise hand-built.
- The browser tests use semantic roles for most behavior, but still depend on `.dashboard-main`, `.page-heading`, `.artifact-heading`, `.artifact-management-grid`, and `.artifact-surface` for layout assertions.

This means Shelf is paying the styling cost of a component system without receiving package-level maintenance or consistency.

## Package set to trial

### Recommended managed core: Kumo

Install from the repository root:

```sh
pnpm --filter @shelf/web add \
  @cloudflare/kumo@2.10.0 \
  @phosphor-icons/react@2.1.10 \
  echarts@6.1.0 \
  zod@4.4.3
```

`echarts` and `zod` are declared Kumo peers. Shelf has `auto-install-peers=false`, so the spike must install them explicitly even though it will not import charts. This is an installation tax to measure, not a reason to import chart code. Kumo marks only CSS as side-effectful and publishes granular component entry points; the acceptance checks below verify that ECharts and Shiki do not leak into the initial bundle.

After every direct `@base-ui/react` import has moved to Kumo, remove the direct dependency:

```sh
pnpm --filter @shelf/web remove @base-ui/react
```

Base UI remains transitively present through Kumo. Do not maintain two public primitive APIs indefinitely.

Use granular imports in production code:

```ts
import { Button } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Select } from '@cloudflare/kumo/components/select';
```

Kumo's documented Tailwind 4 import order must be used in `styles.css`:

```css
@source "../node_modules/@cloudflare/kumo/dist/**/*.{js,jsx,ts,tsx}";
@import "@cloudflare/kumo/styles/tailwind";
@import "tailwindcss";
```

The source path above is relative to `apps/web/src/styles.css`; verify it during the spike rather than copying a path intended for a root-level stylesheet. Set `data-mode="dark"` on the document root and retain `color-scheme: dark`. Do not add a light theme or theme toggle.

### Managed responsibilities

| Shelf need | Kumo package component | Existing custom code to replace |
| --- | --- | --- |
| Primary, secondary, quiet, icon, destructive, and pending actions | `Button`, `LinkButton` | `.control*`, `.quiet-button`, `.icon-button`, handwritten loading labels |
| React Router-aware navigation | `Link`, `LinkProvider` | repeated link-as-button styling and most `.back-link` treatment |
| Text/password/date-time fields and labels | `Input`, `InputGroup`, `Label`, `Field` | `.field`, input borders, focus rings, error-adjacent layout |
| Workspace and revision selection | `Select` | four native `<select>` implementations and their focus/size CSS |
| Grants and share target selection | `Checkbox`, `Radio` | native checkbox/radio styling and checked-card state plumbing |
| Rename, create share, issue credential | `Dialog` | the local Base UI dialog wrapper and roughly 80 lines of overlay/panel CSS |
| Restore and revoke confirmation | `Dialog.Root role="alertdialog"` | generic dialog plus duplicated destructive confirmation styling |
| Artifact/access rows | `Table`, `LayerCard` | row borders, status column alignment, hover surface, most list shell CSS |
| State and visibility labels | `Badge` | `.status-pill`, grant pills, kind text treatments |
| Errors and authority guidance | `Banner` | `.inline-notice`, `.form-error` shell treatment, `.access-principle` chrome |
| No artifacts/no credentials/no shares | `Empty` | `.dashboard-empty` and repeated section-empty structure |
| Share URL, revision ID, CLI command | `ClipboardText`, `Code` | custom `navigator.clipboard` button and CLI cue box styling |
| Success/failure feedback | `Toast` | ad hoc copied/error text and future custom toast work |
| Secondary actions and compact explanations | `DropdownMenu`, `Tooltip`, `Toolbar` | crowded row buttons and future tooltip plumbing |
| History/compare/shares modes | `Tabs` | all-three-panels-at-once detail layout when the tabbed spike wins |
| Code artifacts | `CodeHighlighted` from `@cloudflare/kumo/code` | raw code block styling; Kumo already lazy-loads Shiki through a separate entry point |
| Consistent icons | Phosphor icons | CSS-drawn file/folder glyphs and text arrows where an icon improves scanning |
| Loading placeholders | `Loader`, `SkeletonLine` | `.loading-mark` and future one-off skeleton CSS |

Do not install a new tree library in this pass. Shelf's folder snapshot is already a bounded semantic list, and Kumo does not provide a managed tree. Revisit this only after real large-folder behavior demonstrates a navigation, virtualization, or search need.

## What not to combine

| Combination | Conflict | Rule |
| --- | --- | --- |
| Kumo + HeroUI | Base UI and React Aria both manage focus, selection, overlays, state attributes, and theme layers | Separate worktrees only; the chosen core is the only one merged |
| Kumo + Mantine | Two global token systems, a Mantine provider, two overlay stacks, two field APIs, and duplicate responsive layout abstractions | Mantine is a full replacement option, not a specialist |
| Kumo + Radix shadcn components | Duplicate headless primitives with different composition and state attributes | Do not add Radix registries |
| Kumo + official shadcn/Base UI wrappers | Same substrate but a second styled wrapper/token system that Shelf must maintain locally | Use Kumo's managed component when it exists; use a Kumo primitive only for a real gap |
| Kumo + beUI selects/dialogs/tooltips/checkboxes | beUI copies source into Shelf, implements its own interaction layer, expects shadcn-style tokens, and adds a visibly different motion language | Do not install these generic beUI controls |
| Kumo + beUI specialist motion | `motion` is already inside Kumo, but copied beUI source still becomes Shelf-owned and can over-animate frequent utility actions | Consider one specialist only after a demonstrated Kumo gap; none in the first pass |
| Kumo package + Kumo blocks everywhere | Kumo blocks are copied source, so they no longer outsource updates | Trial no blocks first; add `PageHeader` or `ResourceListPage` only if it deletes more local code than it adds |

beUI is valuable reference work, but it is distributed through a shadcn registry as copied source. Installing a beUI button does not outsource its future maintenance in the way a managed package does. It should not be the core answer to the user's speed requirement.

## Bounded visual spike A: Kumo

### Timebox and isolation

- One local worktree or one reversible local spike commit.
- Maximum four implementation hours before comparison.
- No API, route, contract, or server changes.
- No Kumo source blocks in the first trial.

### Real screens

#### Artifact index

- Keep the thin Shelf map bar and existing `Artifacts`/`Access` information architecture.
- Use Kumo `LinkProvider` once at the root so package links route through React Router.
- Render the CLI-first publish cue with `Code` or `ClipboardText`; the command remains `shelf publish ./path --share`.
- Render the artifact ledger with `LayerCard` + semantic `Table` using name, kind `Badge`, latest revision, size, and updated time.
- On narrow screens, keep name/revision visible and hide kind/size columns with a small amount of Shelf-owned responsive CSS. Horizontal page overflow remains forbidden.
- Use `Empty` for the zero-artifact state. Do not add dashboard metrics, cards, search, filters, or a web publish form.

#### Artifact detail

- Use `Breadcrumbs` for `Artifacts / artifact-name`; keep the map bar compact.
- Use Kumo `Button` for Rename and Share and `DropdownMenu` for secondary actions if the header becomes crowded.
- Keep `ManagedArtifactContent` and the artifact preview surface product-owned.
- Trial `Tabs` for `History`, `Compare`, and `Shares`; this is a density decision, not decoration. The preview stays above the modes.
- Use `Badge` for `Latest`, `ClipboardText` for share URLs and revision IDs, `Select` for comparison revisions, and `Dialog`/`alertdialog` for create, rename, restore, and revoke flows.
- Do not animate tab changes beyond Kumo's default. Frequent artifact navigation must remain immediate.

#### Access

- Use `Banner` for the least-authority guidance.
- Use `Table` for credential name, grants, dates, status, and one compact action menu.
- Use `Dialog`, `Input`, `Checkbox`, and Kumo buttons for issuing a credential.
- Show the one-time credential with `ClipboardText`; never persist it to browser storage.
- Use `alertdialog` for revoke confirmation.

### Affected files

Expected code changes are limited to:

- `apps/web/package.json`
- `pnpm-lock.yaml`
- `apps/web/index.html`
- `apps/web/src/main.tsx`
- `apps/web/src/styles.css`
- `apps/web/src/dashboard/layout.tsx`
- `apps/web/src/dashboard/artifacts-page.tsx`
- `apps/web/src/dashboard/artifact-page.tsx`
- `apps/web/src/dashboard/access-page.tsx`
- `apps/web/src/dashboard/dialogs.tsx` (delete after callers move to Kumo)
- `apps/web/src/dashboard/signin-page.tsx`
- `apps/web/src/dashboard/managed-artifact-content.tsx`
- `apps/web/src/components/artifact-content.tsx` only if `CodeHighlighted` is included in this spike
- the four dashboard CSS files, primarily deletions and remaining product layout
- `apps/web/test/dashboard-architecture.test.ts`
- `apps/web/e2e/browser-smoke.e2e.ts` where assertions reference deleted layout classes

Do not touch API or CLI packages for this trial.

### Expected deletion and reduction

These are targets to verify in the diff, not promises:

- Delete the 83-line local dialog wrapper after migration.
- Delete roughly 250–350 lines of generic control, dialog, field, focus, badge, empty-state, and button CSS immediately.
- Delete another 150–250 lines if `Table`, `Tabs`, `Banner`, `ClipboardText`, and responsive package layouts replace the current repeated row/panel styling cleanly.
- Net target: dashboard CSS falls from 1,451 lines to approximately 850–1,000 lines without adding a local `components/ui` implementation tree.
- No new generic wrapper should exceed about 40 lines. Product-specific artifact mapping and route components are exempt.

If the Kumo pass adds more than 200 lines of override CSS or requires wrapping most components to look like Shelf, the managed-package advantage has failed and spike B should run.

## Bounded visual spike B: HeroUI

Run this only if Kumo fails. Use a fresh worktree from the same baseline; do not uninstall Kumo in-place and continue because that makes the diffs incomparable.

Shelf disables automatic peer installation, so use the complete exact command:

```sh
pnpm --filter @shelf/web add \
  @heroui/react@3.2.4 \
  @heroui/styles@3.2.4 \
  react-aria@3.51.0 \
  react-aria-components@1.20.0 \
  @react-aria/i18n@3.13.1 \
  @react-aria/ssr@3.10.1 \
  @react-aria/utils@3.34.1 \
  @phosphor-icons/react@2.1.10
```

Import order:

```css
@import "tailwindcss";
@import "@heroui/styles";
```

Build the same three real screens with HeroUI `Button`, `Input`, `Select`, `Checkbox`, `Modal`/`AlertDialog`, `Dropdown`, `Table`, `Chip`, `Alert`, `Toast`, `Tabs`, `Breadcrumbs`, `Card`/`Surface`, `Tooltip`, `Skeleton`, and `Kbd`. Use the same content, information hierarchy, icon set, viewport matrix, and timebox as spike A.

HeroUI wins only if it is visibly better on Shelf's actual screens and needs less override CSS. If it wins, remove Base UI entirely rather than leaving Base UI dialogs alongside React Aria fields and overlays:

```sh
pnpm --filter @shelf/web remove @base-ui/react
```

Expected local CSS reduction is similar to Kumo, but the migration surface is larger because every overlay and selection primitive changes substrate. That cost must be reflected in the comparison, not hidden by judging screenshots alone.

## Acceptance checks for either spike

### Behavior

- Artifact index, detail, revision comparison, restore-as-latest, share creation/revocation, credential creation/revocation, sign-in, sign-out, and workspace switching retain their current behavior.
- Semantic names used by the existing browser tests remain stable unless wording is intentionally improved.
- No dashboard publish form, collections, analytics, activity feed, or settings surface appears.
- Secrets remain absent from `localStorage`, `sessionStorage`, logs, and post-reveal navigation.

### Accessibility and interaction

- Keyboard reaches every action, select option, tab, table action, and dialog control.
- Opening a dialog moves focus to the first intended field; Escape closes dismissible dialogs; focus returns to the trigger.
- Destructive confirmations expose `role="alertdialog"` and cannot be completed accidentally by backdrop click.
- Visible focus passes against dark surfaces.
- Axe reports no serious or critical violations.
- Touch targets are at least 44px where controls are isolated on mobile; dense desktop table actions may be smaller if their hit area remains sufficient.

### Responsive and motion

- Test at 1440×900, 768×1024, 390×844, and 320×800.
- Test the existing 200% zoom project and reduced-motion project.
- No horizontal overflow on the page shell; a deliberately scrollable table/code surface must be contained and obvious.
- Frequent navigation and keyboard actions are immediate. Retain only short state/overlay feedback, and ensure reduced motion removes transform-based movement.

### Build and bundle

Run focused checks first, then the repository checks:

```sh
pnpm --filter @shelf/web typecheck
pnpm --filter @shelf/web build
pnpm --filter @shelf/web test:browser
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
```

For Kumo, inspect built assets after the first control-only pass:

```sh
rg -l "echarts|createHighlighter|Shiki" apps/web/dist/assets
du -h apps/web/dist/assets/* | sort -h
```

ECharts and Shiki must not be present in the initial control-only bundle. If `CodeHighlighted` is later adopted, Shiki must be isolated behind the documented `@cloudflare/kumo/code` entry and lazy-loaded; ECharts must remain absent.

### Comparison scorecard

Record, do not intuit, these values for each spike:

| Measure | Pass condition |
| --- | --- |
| Implementation time | At most four hours for the three screens |
| New override CSS | At most 200 lines; lower wins |
| Generic local component code | No copied general-purpose component tree; lower wins |
| Dashboard CSS deleted | At least 400 lines without losing responsive behavior |
| Browser matrix | All supported projects pass; existing Firefox environment blocker may be reported separately |
| Axe | No serious or critical violations |
| Initial JS growth | Measured and explained; unexpected chart/highlighter code is a failure |
| Visual result | Dense, calm, dark, utility-first, and recognizably Shelf—not the provider's demo dashboard |

## Migration sequence after a winning spike

1. Establish the provider's dark tokens, icon set, and React Router link integration.
2. Replace buttons, links, fields, and selects across all three screens.
3. Replace dialogs and confirmations, then rerun keyboard/focus tests before continuing.
4. Replace status, clipboard, banner, empty, toast, and loading states.
5. Replace artifact/access rows and trial detail tabs.
6. Delete superseded CSS and the local dialog wrapper.
7. Remove the direct Base UI dependency if no direct imports remain.
8. Run the full browser/zoom/reduced-motion matrix and code review.
9. Synchronize KTD17, the product plan, and the decision register with the confirmed provider and the specialist-package rule.
10. Commit the winning implementation locally. Do not push, open a PR, or publish.

## Rollback

Each spike should be isolated in one local commit or disposable worktree. Prefer reverting that commit over manually undoing a mixed diff:

```sh
git revert <spike-commit>
```

If dependency-only cleanup is needed before a commit, use the matching command and restore only the spike-owned files from the baseline diff:

```sh
pnpm --filter @shelf/web remove @cloudflare/kumo @phosphor-icons/react echarts zod
```

or:

```sh
pnpm --filter @shelf/web remove \
  @heroui/react @heroui/styles react-aria react-aria-components \
  @react-aria/i18n @react-aria/ssr @react-aria/utils @phosphor-icons/react
```

Do not reset the shared branch or discard unrelated uncommitted work. The losing worktree can be removed only after its screenshots, measurements, and comparison notes have been captured.

## Official-source basis

- [Kumo installation](https://kumo-ui.com/installation/) documents the managed package, granular imports, Tailwind 4 `@source` requirement, Base UI substrate, React Router `LinkProvider`, and the distinction between managed components and copied blocks.
- [Kumo component registry](https://kumo-ui.com/registry/) lists the managed component surface, including buttons, dialogs, tables, clipboard feedback, tabs, empty states, toasts, and loading components.
- [Kumo colors](https://kumo-ui.com/colors/) documents semantic dark-mode tokens and `data-mode="dark"`.
- [Kumo Dialog](https://kumo-ui.com/components/dialog/) documents `dialog`/`alertdialog`, controlled state, focus behavior, and dismissal controls.
- [Kumo Table](https://kumo-ui.com/components/table/) documents semantic table composition and responsive containment patterns.
- [Kumo CodeHighlighted](https://kumo-ui.com/components/code-highlighted/) documents the separate Shiki entry point and lazy loading.
- [HeroUI quick start](https://heroui.com/en/docs/react/getting-started/quick-start) documents React 19, Tailwind 4, and the two managed core packages.
- [HeroUI components](https://heroui.com/en/docs/react/components) confirms the complete application-control surface used by spike B.
- [HeroUI theming](https://heroui.com/en/docs/react/getting-started/theming) documents the CSS-first token system and dark theme controls.
- [beUI](https://beui.dev/) identifies itself as Motion/Tailwind copy-paste source distributed through shadcn, which is why it is treated as a specialist rather than the managed core.

Package metadata was checked against npm on 2026-08-18. Exact versions are intentionally pinned so the visual and browser comparison is reproducible.
