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
    title: "Overview",
    items: [
      {
        slug: "prd",
        label: "Product Requirements",
        blurb: "Vision, users, scope, roadmap, decisions index.",
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
        slug: "ai-agent",
        label: "AI Agent",
        blurb: "Peer model, streaming, tools, multi-agent.",
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
        label: "ADR 0005 — Trust model",
      },
      {
        slug: "adr/0006-ai-agent-threat-model",
        label: "ADR 0006 — AI agent threat model",
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
