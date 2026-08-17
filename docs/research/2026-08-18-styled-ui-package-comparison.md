# Styled UI package comparison for Shelf

Date: 2026-08-18

## Recommendation

Use **Cloudflare Kumo as Shelf's primary web component system**, with its managed npm components replacing the hand-styled Base UI controls. Keep Tailwind CSS 4 for page layout and Shelf-specific semantic tokens, but stop styling buttons, selects, menus, dialogs, tooltips, tabs, badges, tables, clipboard feedback, and loading states from scratch.

The best fallback is **HeroUI v3** if a short rendered trial shows that Kumo cannot be made quiet enough for Shelf without fighting its theme. HeroUI is the strongest fully managed alternative: it targets React 19 and Tailwind 4 directly, has a React Aria accessibility substrate, and ships polished CSS-first components without a Motion dependency.

Do not combine several complete component systems. The fast model is:

1. one managed core package;
2. Shelf-owned layout and artifact presentation;
3. at most one source-installed specialist when the core package has a real gap.

That gives us package-level maintenance and visual consistency without turning Shelf into a generic dashboard or making the app inherit three competing token systems.

## Shelf constraints used in the comparison

- Existing client: React 19.2, Vite 8, React Router, Tailwind CSS 4, and Base UI 1.6.
- Dark-only product, with a restrained utility UI rather than a full administrative suite.
- The web UI needs a small set of high-quality controls and artifact-specific surfaces; the CLI remains the primary publishing workflow.
- Speed matters more than owning the implementation of every primitive.
- Accessibility, keyboard behavior, responsive layouts, and reduced motion are acceptance requirements, not optional polish.

## Comparison

| Candidate | Distribution and substrate | React 19 / Tailwind 4 fit | Pre-styled quality and dark mode | Cost and maintenance | Shelf verdict |
| --- | --- | --- | --- | --- | --- |
| **Cloudflare Kumo 2.10** | Managed `@cloudflare/kumo` package plus optional source-installed blocks; built on Base UI and re-exports its primitives | Excellent. Official Tailwind 4 setup uses `@source` plus Kumo's stylesheet; Kumo itself now builds with Vite 8 | Dense infrastructure-product styling is the closest fit. Complete dark token system; polished buttons, overlays, toolbars, tables, clipboard feedback, and resource-list patterns | Granular imports and package updates reduce app maintenance. The package has broad dependencies (including Motion, Shiki, DayPicker, and D3), although consumer bundlers tree-shake unused modules. Kumo reported a single-button test app at about 44 KB gzip after its Base UI chunking improvement | **First choice**. Smallest migration because it keeps Base UI underneath while outsourcing styles and behavior |
| **HeroUI v3** | Managed `@heroui/react` + `@heroui/styles`; React Aria Components substrate | Exact stated requirements are React 19+ and Tailwind 4. Setup is two packages and one CSS import; no provider is required | Very polished out of the box, full semantic dark theme, 75+ web components, CSS-only animation, and Figma parity | Tree-shaken managed package; no Framer Motion runtime. It introduces React Aria alongside/replacing Base UI and its softer, rounder defaults may need token tuning for Shelf | **Second choice**. Fastest coherent substitute if the team prefers its rendered feel over Kumo |
| **coss/ui** | shadcn registry: copy source into the app; 50+ primitives built directly on Base UI, with particles above them | Excellent Tailwind 4/Base UI fit and very close to the current stack | Strong, crisp dense-application styling and thoughtful borders/shadows; dark tokens are part of the style preset | Per-component source keeps runtime lean, but Shelf owns updates after installation. Official docs still label it early development and warn about breaking changes. The UI directory is MIT licensed; the wider monorepo uses mixed licensing | **Best source-owned option**, but not preferred for the new goal of outsourcing ongoing component maintenance |
| **Official shadcn/ui with Base UI** | Registry copies source into Shelf; official shadcn now defaults new projects to Base UI | Excellent. React 19 and Tailwind 4 are supported, and Base UI is already present | Good neutral baseline with dark variables, but it is intentionally a starting point rather than a distinctive finished visual system | Base UI is tree-shakable and the registry installs only selected source. Shelf must maintain the copied styles and every local variation | Good migration bridge, not enough outsourcing by itself |
| **beUI** | shadcn registry copies Motion/Tailwind source into Shelf | Stated React 19 and Tailwind 4 support | Strong motion demos and useful stateful controls; dark rendering depends on shadcn-style theme tokens. Reduced-motion handling is present in the catalog | Select and modal items pull `motion`, `clsx`, `lucide-react`, and `tailwind-merge`; copied code becomes Shelf's responsibility. Its button is a native Motion button rather than an accessibility primitive and does not replace a complete design system | **Special effects only, not a core**. Avoid initially; Kumo already covers loading, copy, toast, tooltip, and overlay feedback with less visual mixing |
| **Kibo UI** | shadcn registry copies complex components and their dependencies into Shelf | React 18+ and shadcn CSS-variable mode; Tailwind integration comes through shadcn | Useful specialist catalog: code block, dropzone, image zoom, relative time, snippet, status, and tree | Only chosen components ship, but Shelf owns them. It requires an initialized shadcn foundation and may introduce Radix or other headless libraries beside Base UI | Use only for a demonstrated specialist gap. Do not install its generic buttons/dialogs on top of Kumo or HeroUI |
| **Mantine 9** | Managed `@mantine/core` + provider + Mantine CSS/theme system | React 19 fit is excellent; Vite is officially supported. It is not Tailwind-native | Mature, broad, accessible-looking application kit with first-class forced dark mode and 100+ components | Stable and heavily used, but it adds a parallel theme/CSS system. Full core styles are imported by default, though per-component CSS imports are supported | High-quality library, poor incremental fit. Choose it only if replacing Tailwind as the component styling system, which Shelf does not need |
| **React Aria Components starter kit** | Headless managed behavior package; Adobe offers downloadable styled Tailwind and vanilla-CSS starter source | Strong React fit and styling-agnostic Tailwind compatibility | Best-in-class accessible behaviors. Starter source includes dark, high-contrast, and interaction states, but the managed package itself is unstyled | Tree-shaken behavior; the downloaded starter becomes Shelf-owned styling | Excellent substrate, but it solves less of the user's “install quality and keep moving” request than HeroUI, which already styles React Aria |
| **React Spectrum S2** | Managed `@react-spectrum/s2` package with React Aria behavior and Adobe's complete visual system | React 19 supported; Vite and React Router guides exist, but its style macros and provider are a separate system from Tailwind | Extremely polished, adaptive, dark-mode, touch, localization, and reduced-motion support | Aggressively tree-shaken with atomic CSS, but the npm package is large on disk and requires macro/build integration. Internal component styling is deliberately difficult to override | Technically excellent, but too strongly Adobe-branded and too invasive for Shelf's small utility surface |

### Evidence behind the table

- [Kumo installation](https://kumo-ui.com/installation/) documents the managed package, granular imports, Base UI re-exports, Tailwind 4 setup, optional source-installed blocks, and its component/primitive split. Its [semantic color system](https://kumo-ui.com/colors/) has explicit light/dark values, surface hierarchy, focus, status, and border tokens. The [accessibility guide](https://kumo-ui.com/accessibility/) covers keyboard navigation and focus management, while the [2.10 changelog](https://kumo-ui.com/changelog/) demonstrates current maintenance and records the earlier single-button bundle measurement. Kumo is [MIT licensed](https://github.com/cloudflare/kumo).
- [HeroUI's current quick start](https://heroui.com/en/docs/react/getting-started/quick-start) requires React 19+ and Tailwind 4. Its [v3 release design](https://heroui.com/en/docs/react/releases/v3-0-0) documents React Aria, CSS-only motion, 75+ components, CSS variables, and Figma parity. [Current releases](https://heroui.com/en/docs/react/releases) show active maintenance, including accessibility and component fixes.
- [coss/ui's introduction](https://coss.com/ui/docs) explains its Base UI/Tailwind, copy-and-own model and early-development warning. The [setup guide](https://coss.com/ui/docs/get-started) lists its 50+ primitives, shadcn registry flow, and Base UI re-exports. The [repository](https://github.com/cosscom/coss) identifies it as Cal.com's design system and documents the UI directory's MIT license within a mixed-license monorepo.
- [shadcn's July 2026 announcement](https://ui.shadcn.com/docs/changelog/2026-07-base-ui-default) makes Base UI the default for new projects and explicitly recommends it for new work. [Base UI's quick start](https://base-ui.com/react/overview/quick-start) confirms that the package is tree-shakable. shadcn itself remains [MIT licensed source distribution](https://github.com/shadcn-ui/ui).
- [beUI's catalog](https://beui.dev/) states React 19, Tailwind 4, Motion, and shadcn-registry distribution. Its [button implementation and dependencies](https://beui.dev/components/motion/button) show the actual source-owned native Motion button model, while the [repository](https://github.com/starc007/ui-components) confirms MIT licensing and active development.
- [Kibo setup](https://www.kibo-ui.com/docs/setup) requires shadcn CSS-variable mode and installs selected source plus dependencies. Its [catalog](https://www.kibo-ui.com/) and [MIT repository](https://github.com/shadcnblocks/kibo) show the specialist components and source-owned model.
- [Mantine's setup](https://mantine.dev/getting-started/), [dark color-scheme controls](https://mantine.dev/theming/color-schemes/), and [CSS import strategy](https://mantine.dev/styles/mantine-styles/) confirm Vite support, forced dark mode, and the parallel CSS system. Its [repository](https://github.com/mantinedev/mantine) shows the mature MIT project and 100+ component catalog.
- [React Aria's getting started guide](https://react-spectrum.adobe.com/react-aria/getting-started.html) describes the unstyled accessibility package and fully styled starter kits with dark/high-contrast states. [React Spectrum S2](https://react-spectrum.adobe.com/s2/index.html) and its [Vite/React Router setup](https://react-spectrum.adobe.com/getting-started) document the polished managed alternative, atomic styling, provider, macros, adaptive dark mode, and modern bundler setup.

Package metadata checked directly from npm on 2026-08-18: Kumo 2.10.0, HeroUI 3.2.4, Mantine core 9.5.1, React Spectrum S2 1.6.0, React Aria Components 1.20.0, and Base UI 1.7.0. Versions should be exact-pinned when adopted and deliberately upgraded after browser tests.

## Recommended combination A: Kumo core

Install:

```sh
pnpm --filter @shelf/web add @cloudflare/kumo@2.10.0 @phosphor-icons/react@2.1.10
```

Adopt these package components immediately:

| Shelf surface | Kumo component |
| --- | --- |
| Primary, secondary, icon, destructive, pending actions | `Button`, `LinkButton` |
| Workspace/revision/visibility choice | `Select`, later `Combobox` only if search becomes necessary |
| Artifact/share actions | `Dropdown`, `Toolbar`, `Tooltip` |
| Create share, restore, revoke confirmation | `Dialog` |
| Status and visibility labels | `Badge`, `Banner` |
| Copy share URL, revision ID, CLI command | `ClipboardText` |
| Source/text presentation when highlighting is genuinely useful | `CodeHighlighted` |
| Artifact list and revision ledger | `Table` or the source-installed `ResourceList` block after a visual trial |
| No artifacts/no shares | `Empty` |
| Async transitions | `Loader`, `SkeletonLine`, `Toast` |
| Artifact detail modes | `Tabs` |
| Page structure | Trial the `PageHeader` block, but keep Shelf's thin map bar and viewer shell product-owned |

Do **not** initially adopt Kumo's charts, maps, sidebar, date picker, or flow components. Shelf does not need them. Granular component imports should be used in app code, and Kumo's Tailwind `@source`/style imports must be added exactly as documented.

The package already includes Base UI, so remove the web app's direct `@base-ui/react` dependency after all direct imports are migrated. Do not retain two public primitive APIs indefinitely.

## Recommended combination B: HeroUI core

Install:

```sh
pnpm --filter @shelf/web add @heroui/react@3.2.4 @heroui/styles@3.2.4 react-aria@3.51.0 react-aria-components@1.20.0
```

Adopt the equivalent HeroUI components: `Button`, `Select`, `Menu`/`Dropdown`, `Modal`/`AlertDialog`, `Tooltip`, `Tabs`, `Table`, `Chip`, `Toast`, `Skeleton`, `Spinner`, and form field components. Use its CSS variables to force one Shelf dark theme and lower the global radius/density rather than restyling each control.

Choose this path only as a coherent Base UI-to-React Aria switch. Do not keep Base UI dialogs/selects alongside HeroUI dialogs/selects.

## Specialist package policy

Package count is not the constraint; competing foundations are. A specialist is allowed only when all four are true:

1. the selected core does not provide the behavior;
2. the behavior is already required by a Shelf acceptance path;
3. it can consume Shelf's semantic tokens without introducing a visible second design system;
4. it passes keyboard, reduced-motion, mobile, and bundle verification.

Likely future specialist candidates:

- Kibo `tree` only when the folder browser needs behavior beyond a bounded nested list;
- Kibo `dropzone` only when the dashboard gains a real file-upload flow rather than CLI-first publishing;
- a dedicated diff renderer only when content-aware diffs enter scope;
- beUI `StatefulButton` or `AnimatedToastStack` only if user testing shows Kumo/HeroUI feedback is insufficient. Do not add magnetic, ripple, tilt, shader, dock, or morphing navigation effects to this utility product.

## Fast validation before locking the decision

Build one disposable route with the same Shelf data in both candidates. Each trial should contain only:

- the thin map bar;
- six artifact rows;
- workspace select;
- share dropdown;
- copy-link feedback;
- restore confirmation dialog;
- empty state;
- narrow mobile layout.

Judge the rendered result on five things: density, dark surface quality, keyboard/focus behavior, mobile touch targets, and the amount of override CSS. Select Kumo unless HeroUI is visibly better **and** needs no more customization. The losing package should be removed immediately; the experiment must not leave both systems in the production dependency graph.

## Decision to update if the trial succeeds

KTD17 should change from “direct Base UI primitives, no shared UI package” to:

> Shelf uses one dark React client with Tailwind CSS 4 for layout and Shelf semantic tokens, and Cloudflare Kumo as the managed, pre-styled component system. Kumo's Base UI substrate supplies accessible interaction behavior. The app owns product-specific shells and artifact presentation, not generic controls. Additional registries or motion packages require a demonstrated component gap and may not introduce a second primitive or token system.

This is a deliberate reversal of the earlier assumption: the current implementation demonstrated that direct primitives leave too much low-value visual and interaction work inside Shelf.
