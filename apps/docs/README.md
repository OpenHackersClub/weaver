# @weaver/docs

Landing page + documentation site for weaver.

Built with [Astro](https://astro.build). Documentation content is sourced from
the monorepo-root `specs/` directory via [Astro Content Collections](https://docs.astro.build/en/guides/content-collections/).

## Develop

From the monorepo root:

```sh
pnpm install
pnpm dev
```

Then open <http://127.0.0.1:4321>.

## Build

```sh
pnpm build
pnpm preview
```

## Layout

```
src/
├── components/    — Header, Sidebar, MermaidRunner, etc.
├── layouts/       — BaseLayout (landing) + DocLayout (docs pages)
├── lib/
│   ├── nav.ts            — sidebar configuration
│   ├── site.ts           — brand/site constants
│   └── remark-mermaid.mjs — mermaid block extraction (rendered client-side)
├── pages/
│   ├── index.astro       — landing page
│   └── docs/
│       ├── index.astro   — docs hub
│       └── [...slug].astro — dynamic content-collection page
├── styles/
│   └── global.css        — design system
└── content.config.ts     — content collection loader (globs ../../specs)
```

## Content collection

`src/content.config.ts` globs `**/*.md` from `../../specs` (monorepo root).
Frontmatter is optional; titles fall back to the sidebar label or first H1.

To add a new doc, drop a `.md` file in `specs/` (or `specs/adr/`) and add an
entry to `src/lib/nav.ts`.

## Mermaid

`remark-mermaid.mjs` rewrites fenced ```mermaid blocks into
`<div class="mermaid-source" data-source="...">` wrappers. `MermaidRunner.astro`
lazy-loads `mermaid` on the client and renders them into SVG, re-rendering on
theme change.

## Theme

CSS variables + `data-theme` attribute on `<html>`. Light = "paper" (warm
off-white), dark = "terminal" (near-black). Toggle persists in `localStorage`
under `weaver:theme`.
