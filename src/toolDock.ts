// The paste page's tool dock: the ONE list of reader tools, and the pure functions
// that carry a tool's availability across the server → DOM → client seam.
//
// [LAW:one-source-of-truth] A tool is one record here. The bar button and the panel
// on [slug].astro are two projections of that record — the label a reader taps and
// the heading above the panel it opens can never name different things, and the id
// that links button to panel is read off the record rather than retyped as a string
// literal in two places.
//
// [LAW:decomposition] This module knows what the tools ARE. It knows nothing about
// what any of them DO (each tool keeps its own markup and its own script on the page)
// and nothing about how the dock animates. One sentence, no "and".

// [LAW:types-are-the-program] When a tool is reachable. The `when` arm's tuple is
// non-empty BY TYPE: `{ kind: "when", bodyClasses: [] }` would read as "gated on
// nothing", which any honest evaluator resolves to *never available* — an
// answer-shaped void. The type refuses to let anyone write it.
//
// A tool's own script adds its body class once it has confirmed it can actually act
// (clipboard present, network edge wired). Gating the dock item on that same class
// is what keeps the menu free of dead controls [LAW:no-silent-failure]: a browser
// with no clipboard shows no "Copy all code", rather than a button that does nothing.
export type ToolAvailability =
  | { readonly kind: "always" }
  | { readonly kind: "when"; readonly bodyClasses: readonly [string, ...string[]] };

type ToolSpec = {
  readonly id: string;
  // The bar item's caption AND the panel's heading — one word for one tool.
  readonly label: string;
  // What the panel is for, in a phrase. Rides as the bar item's tooltip/aria-label.
  readonly hint: string;
  // Inline SVG, author-written and constant, drawn with currentColor so it inherits
  // the item's own state colours rather than carrying a second palette.
  readonly icon: string;
  readonly availability: ToolAvailability;
};

const icon = (paths: string): string =>
  `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

// The launcher's two faces. Sliders read as "controls" rather than the navigation a
// hamburger promises; the cross is what the same button means once the menu is out.
// Both live here with the tool icons so the dock's whole iconography has one home
// [LAW:one-source-of-truth].
export const LAUNCHER_ICON = icon(
  '<path d="M3 6h3M10 6h7M3 13h7M14 13h3"/><circle cx="8" cy="6" r="2"/><circle cx="12" cy="13" r="2"/>',
);
export const LAUNCHER_CLOSE_ICON = icon('<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>');

// [LAW:no-mode-explosion] The menu order is the reading order of the toolset, stated
// once: comprehension aids first, then things you take away with you, then provenance.
//
// [LAW:one-source-of-truth] This array IS the enumeration of tools — ToolId is read
// back OFF it below rather than hand-written beside it. A second hand-kept union
// would be a map that can drift from its territory: a tool present in one and absent
// from the other compiles fine and fails at runtime.
const TOOLS = [
  {
    id: "outline",
    label: "Outline",
    hint: "Jump to any turn",
    icon: icon(
      '<circle cx="4" cy="5" r="1.1"/><circle cx="4" cy="10" r="1.1"/><circle cx="4" cy="15" r="1.1"/>' +
        '<path d="M8 5h8M8 10h8M8 15h5"/>',
    ),
    availability: { kind: "always" },
  },
  {
    id: "search",
    label: "Search",
    hint: "Search this conversation",
    icon: icon('<circle cx="8.75" cy="8.75" r="5.25"/><path d="M12.6 12.6L17 17"/>'),
    availability: { kind: "when", bodyClasses: ["search-ready"] },
  },
  {
    id: "ask",
    label: "Ask",
    hint: "Ask this conversation a question",
    icon: icon(
      '<path d="M17 11.5a4.5 4.5 0 0 1-4.5 4.5H7.6L3.5 18.5V7.5A4.5 4.5 0 0 1 8 3h4.5A4.5 4.5 0 0 1 17 7.5z"/>' +
        '<path d="M8.4 8.1a1.85 1.85 0 1 1 2.85 1.55c-.55.36-.85.72-.85 1.35"/><path d="M10.4 13.4v.01"/>',
    ),
    availability: { kind: "when", bodyClasses: ["ask-ready"] },
  },
  {
    id: "tldr",
    label: "TL;DR",
    hint: "Summarize this conversation",
    icon: icon(
      '<path d="M6.6 2.8l1.05 2.75L10.4 6.6 7.65 7.65 6.6 10.4 5.55 7.65 2.8 6.6l2.75-1.05z"/>' +
        '<path d="M13.6 10.2l.75 1.95 1.95.75-1.95.75-.75 1.95-.75-1.95-1.95-.75 1.95-.75z"/>',
    ),
    availability: { kind: "when", bodyClasses: ["tldr-ready"] },
  },
  {
    id: "listen",
    label: "Listen",
    hint: "Read this conversation aloud",
    icon: icon(
      '<path d="M4.5 8.2v3.6"/><path d="M7.6 5.6v8.8"/><path d="M10.7 3.4v13.2"/>' +
        '<path d="M13.8 6.4v7.2"/><path d="M16.9 8.8v2.4"/>',
    ),
    // The item appears once the page has WebGPU, so the voice MAY work; the full answer
    // comes only from the worker the first tap spawns. A reader without it sees no Listen,
    // rather than a play button that stays silent.
    availability: { kind: "when", bodyClasses: ["speech-ready"] },
  },
  {
    id: "code",
    label: "Code",
    hint: "Copy or download every code block",
    icon: icon('<path d="M7.2 6.5L3.5 10l3.7 3.5"/><path d="M12.8 6.5L16.5 10l-3.7 3.5"/><path d="M11.2 4.2L8.8 15.8"/>'),
    // Either capability alone makes the panel worth opening: a browser with no
    // clipboard can still download the zip, and the reverse holds too.
    availability: { kind: "when", bodyClasses: ["copy-all-ready", "download-ready"] },
  },
  {
    id: "continue",
    label: "Continue",
    hint: "Copy this conversation to continue it elsewhere",
    icon: icon('<path d="M10 13V3"/><path d="M6.6 6.2L10 2.8l3.4 3.4"/><path d="M4 12v4.2h12V12"/>'),
    availability: { kind: "when", bodyClasses: ["copy-continuation-ready"] },
  },
  {
    id: "compare",
    label: "Compare",
    hint: "Diff this paste against another",
    icon: icon('<path d="M10 2.8v14.4"/><rect x="2.8" y="5.4" width="4.6" height="9.2" rx="1"/><rect x="12.6" y="5.4" width="4.6" height="9.2" rx="1"/>'),
    availability: { kind: "when", bodyClasses: ["compare-ready"] },
  },
  {
    id: "freshness",
    label: "Live page",
    hint: "Check this snapshot against the live page",
    icon: icon('<circle cx="10" cy="10" r="7.2"/><path d="M10 5.8V10l2.9 1.8"/>'),
    availability: { kind: "when", bodyClasses: ["freshness-ready"] },
  },
  {
    id: "versions",
    label: "Versions",
    hint: "Snapshots archived before earlier refetches",
    icon: icon('<path d="M3.2 6.2L10 3l6.8 3.2L10 9.4z"/><path d="M3.2 10L10 13.2 16.8 10"/><path d="M3.2 13.8L10 17l6.8-3.2"/>'),
    availability: { kind: "always" },
  },
] as const satisfies readonly ToolSpec[];

// The tool set, read off the one array: every id that exists, and nothing else. A new
// entry above widens ToolId, which is what makes the paste page's
// `satisfies Record<ToolId, boolean>` presence map fail to compile until the new tool
// is given an answer [LAW:types-are-the-program].
export type ToolId = (typeof TOOLS)[number]["id"];
export type DockTool = ToolSpec & { readonly id: ToolId };
export const DOCK_TOOLS: readonly DockTool[] = TOOLS;

// [LAW:one-source-of-truth] Tools addressed by record, never by a retyped string:
// the panel markup writes `data-tool={TOOL.search.id}`, so a typo is a type error
// rather than a panel the bar can never find. The per-key type is the exact entry
// from the array, so TOOL.search.id narrows to "search" and cannot be another tool.
export const TOOL = Object.fromEntries(TOOLS.map((t) => [t.id, t])) as {
  readonly [K in ToolId]: Extract<(typeof TOOLS)[number], { id: K }>;
};

// [LAW:one-source-of-truth] The DOM id linking a bar button (aria-controls) to its
// panel, derived from the tool id in one place so the two ends cannot drift.
export const panelDomId = (id: ToolId): string => `tool-panel-${id}`;

// The server's half of the availability seam: what `data-requires` says, or nothing
// at all for a tool that needs no capability. Absence is the encoding of "always" —
// and the parser below is the only thing allowed to read it back.
export const requiresAttr = (a: ToolAvailability): string | undefined =>
  a.kind === "always" ? undefined : a.bodyClasses.join(" ");

// [LAW:parse-dont-validate] The client's half: the attribute becomes the typed value
// again, so `isAvailable` below is handed a ToolAvailability and never a raw string
// it would have to re-interpret. An ABSENT attribute is the legitimate "always" the
// server writes; a PRESENT but empty one is a broken projection — it would evaluate
// to "gated on nothing", the exact answer-shaped void the type forbids — so it fails
// loudly here rather than hiding a tool for reasons nobody can trace
// [LAW:no-silent-failure].
export const parseAvailability = (requires: string | null | undefined): ToolAvailability => {
  if (requires === null || requires === undefined) return { kind: "always" };
  const classes = requires.split(/\s+/).filter((c) => c.length > 0);
  const [first, ...rest] = classes;
  if (first === undefined) {
    throw new Error(`tool dock: empty data-requires — availability cannot be gated on nothing`);
  }
  return { kind: "when", bodyClasses: [first, ...rest] };
};

// [LAW:dataflow-not-control-flow] One total reading of the availability value. The
// `when` arm is an ANY: a tool with two capability classes is reachable as soon as
// either capability wires up, because its panel holds a control for each.
export const isAvailable = (
  a: ToolAvailability,
  hasBodyClass: (cls: string) => boolean,
): boolean => (a.kind === "always" ? true : a.bodyClasses.some(hasBodyClass));
