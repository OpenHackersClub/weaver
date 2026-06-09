/**
 * Sidebar navigation for the docs site.
 * Each entry's `slug` matches the content collection id under specs/.
 */

export type NavItem = {
  slug: string;
  label: string;
  blurb?: string;
};

export type NavSection = {
  number: string;
  title: string;
  items: NavItem[];
};

export const nav: NavSection[] = [
  {
    number: "00",
    title: "Get started",
    items: [
      {
        slug: "prd",
        label: "Introduction",
        blurb: "What weaver is, who it's for, what ships in v1, and the decisions behind it.",
      },
    ],
  },
  {
    number: "01",
    title: "Architecture",
    items: [
      {
        slug: "architecture",
        label: "System Architecture",
        blurb: "Packages, document model, reactivity, plugin contract.",
      },
      {
        slug: "block-model",
        label: "Block Model",
        blurb: "Block data structure, Loro mapping, Effect-TS SubscriptionRef stores, the layering rule.",
      },
      {
        slug: "hard-problems",
        label: "Hard Problems",
        blurb: "The eleven genuinely-hard implementation problems.",
      },
      {
        slug: "wasm-strategy",
        label: "WASM Strategy",
        blurb: "Five concrete WASM uses; the Zero pattern stolen for read-models.",
      },
      {
        slug: "ui-framework-compatibility",
        label: "Framework Compatibility",
        blurb: "Which UI frameworks integrate with weaver, and the WASM + Effect-TS complexity that shapes each adapter.",
      },
      {
        slug: "ai-agent",
        label: "AI Agent",
        blurb: "Peer model, streaming, tools, multi-agent.",
      },
      {
        slug: "mentions",
        label: "Mentions",
        blurb: "Tagging principals (people and agents) in-document: trigger UX, mention mark, debounced MentionCreated events.",
      },
      {
        slug: "access-control",
        label: "Access Control",
        blurb: "Tokens, schemas, op validation, audit, threat model, gaps.",
      },
    ],
  },
  {
    number: "02",
    title: "Reference",
    items: [
      {
        slug: "comparison",
        label: "Editor Comparison",
        blurb: "weaver vs Lexical, ProseMirror, Tiptap, BlockSuite, others.",
      },
      {
        slug: "lexical-parity",
        label: "Lexical Parity",
        blurb: "Catalog of Lexical features mapped to weaver primitives, with the v1 outcome rubric.",
      },
      {
        slug: "implementation-guideline",
        label: "Implementation Guideline",
        blurb: "Effect-TS pattern matching, tagged errors, state ownership — the code-level conventions a reviewer can block on.",
      },
      {
        slug: "benchmarks",
        label: "Benchmarks",
        blurb: "What we measure, how, the v1 pass bars, and the outcome rubric.",
      },
      {
        slug: "playground",
        label: "Playground",
        blurb: "Standalone demo webapp shipped to Cloudflare Pages — what it demos and how it ships.",
      },
    ],
  },
  {
    number: "03",
    title: "Decision Records",
    items: [
      {
        slug: "adr/0001-adopt-loro-over-yjs",
        label: "ADR 0001 — Loro over Y.js",
      },
      {
        slug: "adr/0002-notion-style-block-model",
        label: "ADR 0002 — Notion-style block model",
      },
      {
        slug: "adr/0003-concurrent-semantics-no-global-rw-aw",
        label: "ADR 0003 — Concurrent semantics",
      },
      {
        slug: "adr/0004-capability-token-format",
        label: "ADR 0004 — Capability token format",
      },
      {
        slug: "adr/0005-trust-model",
        label: "ADR 0005 — Trust model & threat surface",
      },
      {
        slug: "adr/0006-ui-state-effect-over-valtio",
        label: "ADR 0006 — UI state: Effect-TS over Valtio",
      },
    ],
  },
];

export const allItems = (): NavItem[] =>
  nav.flatMap((section) => section.items);

export const findNext = (slug: string): NavItem | undefined => {
  const flat = allItems();
  const idx = flat.findIndex((i) => i.slug === slug);
  return idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : undefined;
};

export const findPrev = (slug: string): NavItem | undefined => {
  const flat = allItems();
  const idx = flat.findIndex((i) => i.slug === slug);
  return idx > 0 ? flat[idx - 1] : undefined;
};
