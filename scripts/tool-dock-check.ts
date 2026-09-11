// Tool dock checks (slopspot-tool-dock-44r). Run: `tsx scripts/tool-dock-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure. Verifies the PURE
// half of the dock (src/toolDock.ts) off-DOM, plus the one fact the compiler cannot
// reach: that every capability class a tool is gated on is actually added by a script
// on the paste page. A tool gated on a class nobody adds is invisible forever, and
// nothing about that is a type error [LAW:no-silent-failure].
//
// Behavioural, not structural: nothing here asserts how the dock is laid out, animated,
// or wired — only what its values MEAN [LAW:behavior-not-structure].

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOCK_TOOLS,
  TOOL,
  isAvailable,
  panelDomId,
  parseAvailability,
  requiresAttr,
  type ToolAvailability,
} from "../src/toolDock";
import { DOCK_SELECTORS } from "../src/toolDockView";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const has = (...classes: string[]) => (cls: string): boolean => classes.includes(cls);

console.log("\nThe tool list is one enumeration:");

const ids = DOCK_TOOLS.map((t) => t.id);
assert("the dock offers tools at all", ids.length > 0);
assert("no two tools share an id", new Set(ids).size === ids.length);
assert(
  "TOOL is keyed by exactly the ids in DOCK_TOOLS",
  Object.keys(TOOL).sort().join(",") === [...ids].sort().join(","),
);
assert(
  "every TOOL entry is the array entry it is keyed by",
  ids.every((id) => TOOL[id] === DOCK_TOOLS.find((t) => t.id === id)),
);
assert(
  "no two tools claim the same panel DOM id",
  new Set(ids.map(panelDomId)).size === ids.length,
);
assert(
  "every tool carries a label, a hint, and an svg icon",
  DOCK_TOOLS.every((t) => t.label.length > 0 && t.hint.length > 0 && t.icon.startsWith("<svg")),
);

console.log("\nAvailability survives the server → DOM → client round trip:");

// The seam's whole contract: what the server writes into data-requires, the client
// parses back into the SAME value. Asserted over the real tool list, so a tool added
// with a shape the attribute cannot carry fails here rather than in a browser.
for (const tool of DOCK_TOOLS) {
  const back = parseAvailability(requiresAttr(tool.availability));
  assert(
    `${tool.id}: ${JSON.stringify(tool.availability)} round-trips`,
    JSON.stringify(back) === JSON.stringify(tool.availability),
  );
}

// An ABSENT attribute is how the server writes "always" — the only reading that keeps
// an ungated tool reachable.
assert("absent attribute parses as always", parseAvailability(undefined).kind === "always");
assert("null attribute parses as always", parseAvailability(null).kind === "always");
assert(
  "one class parses as a one-class gate",
  JSON.stringify(parseAvailability("search-ready")) ===
    JSON.stringify({ kind: "when", bodyClasses: ["search-ready"] }),
);
assert(
  "several classes parse as a many-class gate",
  JSON.stringify(parseAvailability("copy-all-ready download-ready")) ===
    JSON.stringify({ kind: "when", bodyClasses: ["copy-all-ready", "download-ready"] }),
);
assert(
  "surrounding and repeated whitespace collapses",
  JSON.stringify(parseAvailability("  a   b  ")) ===
    JSON.stringify({ kind: "when", bodyClasses: ["a", "b"] }),
);

// A PRESENT but empty attribute would mean "gated on nothing", which is a tool that can
// never appear. It is a broken projection, and it fails loudly rather than vanishing.
const throwsOn = (raw: string): boolean => {
  try {
    parseAvailability(raw);
    return false;
  } catch {
    return true;
  }
};
assert("an empty attribute throws rather than hiding a tool", throwsOn(""));
assert("a whitespace-only attribute throws too", throwsOn("   "));

console.log("\nAvailability reads as any-of, never all-of:");

const always: ToolAvailability = { kind: "always" };
const oneOf: ToolAvailability = { kind: "when", bodyClasses: ["a"] };
const eitherOf: ToolAvailability = { kind: "when", bodyClasses: ["a", "b"] };
assert("always needs no class", isAvailable(always, has()));
assert("a gated tool is unavailable with no class", !isAvailable(oneOf, has()));
assert("a gated tool is available with its class", isAvailable(oneOf, has("a")));
assert("an unrelated class does not admit it", !isAvailable(oneOf, has("z")));
assert("a two-class gate opens on the first", isAvailable(eitherOf, has("a")));
assert("a two-class gate opens on the second alone", isAvailable(eitherOf, has("b")));
assert("a two-class gate stays shut on neither", !isAvailable(eitherOf, has("z")));

console.log("\nEvery gate names a class the page actually adds:");

// [LAW:one-source-of-truth] The capability classes live in two places by necessity —
// the tool that earns one adds it, the dock that reads one is gated on it — and only
// this check can hold them together. A gate on a class no script adds is a tool the
// reader can never reach, with nothing in the type system to say so.
const pagePath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "pages", "[slug].astro");
const page = readFileSync(pagePath, "utf8");
const cssPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "styles", "global.css");
const css = readFileSync(cssPath, "utf8");
// [LAW:parse-dont-validate] Commentary is neither markup nor a stylesheet. Every scrape below
// asks what a file AUTHORS, and a commented-out `class={…}`, or a class named in prose, still
// reads as the real thing to any regex over raw text. Both sources are parsed to their
// authored form once, here, so the patterns ask the question they were written to ask.
//
// The two strips are deliberately separate rather than one shared helper: `//` and `<!-- -->`
// are not CSS comments (a `url(//host)` would be eaten), and `{/* … */}` is not a CSS form.
// One function spanning both would be a false unification of two comment grammars.
//
// The block form is what matters for the template and is the one an earlier version of this
// missed: [slug].astro carries ZERO `<!-- -->` comments and comments exclusively with
// `{/* … */}`, so stripping only HTML comments was a no-op against the very file it cleaned —
// and a mutation test written in `<!-- -->` "confirmed" it, because the mutation was written
// in the idiom of the patch instead of the idiom of the file [LAW:verifiable-goals].
const markup = page.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
// [LAW:parse-dont-validate] The page is parsed ONCE into the set of classes it actually
// ADDS to document.body; every gate is then a membership question against that set. The
// weaker question — does this quoted string appear anywhere in the file — let a class
// named only in a comment, a selector, or a data attribute pass as added, which is the
// exact false pass this check exists to prevent.
//
// Three seams do the adding: most tools call classList.add with the literal, the two
// payload tools route through wirePayloadCopy(…, readyClass) and add a parameter, and
// Listen, whose class answers two capabilities, calls classList.toggle with the literal
// and the answer. All three are read. A FOURTH seam introduced later falls outside this extraction, and every gate
// through it then fails as "no script adds it" — loudly wrong rather than quietly passing
// [LAW:no-silent-failure]. That is the only failure direction that keeps the check worth
// running: a miss here costs a false alarm, never an invisible tool.
const captured = (pattern: RegExp): readonly string[] =>
  [...markup.matchAll(pattern)].map(([match, cls]) => {
    if (cls === undefined) {
      throw new Error(`tool-dock-check: ${pattern} matched ${match} without capturing a class`);
    }
    return cls;
  });

const addedClasses = new Set([
  ...captured(/document\.body\.classList\.add\("([^"]+)"\)/g),
  ...captured(/wirePayloadCopy\([^)]*"([^"]+)"\s*\)/g),
  ...captured(/document\.body\.classList\.toggle\("([^"]+)",/g),
]);

// One positive control per seam: an extraction that silently matched nothing would make
// every assertion below fail for the wrong reason, so each spelling proves itself first.
assert("the inline classList.add seam is read", addedClasses.has("search-ready"));
assert("the wirePayloadCopy seam is read", addedClasses.has("copy-all-ready"));
assert("the classList.toggle seam is read", addedClasses.has("speech-ready"));
// A class no tool script has ever heard of must fail, or this check proves nothing.
assert("a fictional class is not found", !addedClasses.has("no-such-tool-ready"));

// [LAW:dataflow-not-control-flow] An ungated tool contributes an empty list of classes
// rather than skipping the loop body — the same iteration runs for every tool, and the
// availability value alone decides how many gates it has to answer for.
const gatesOf = (a: ToolAvailability): readonly string[] =>
  a.kind === "always" ? [] : a.bodyClasses;

for (const tool of DOCK_TOOLS) {
  for (const cls of gatesOf(tool.availability)) {
    assert(`${tool.id} is gated on body.${cls}, which a script adds`, addedClasses.has(cls));
  }
}

console.log("\nEvery region the dock resolves is authored in the page's markup:");

// [LAW:one-source-of-truth] The class STRINGS are no longer this check's business. The page
// interpolates `DOCK_SELECTORS` for every region the module resolves, so the two ends cannot
// spell a region differently — a rename lands in the markup on the next build, and the
// compiler is the enforcer rather than this scrape. That is the higher rung, and taking it
// deleted the drift this block used to watch for [FRAMING:representation].
//
// What no type can see is whether the page authors a region AT ALL: `resolveDock` requires
// each one and throws for every reader if it is missing, while a template with the block
// deleted type-checks perfectly clean. The jsdom check cannot see it either — it builds its
// fixture from these same constants, so it would go missing right along with the page and
// keep passing. So the scrape is left owning exactly the one question nothing else can ask.
// Anchored inside a `class={…}` attribute, exactly as the panel scrape below is. A bare
// `/DOCK_SELECTORS\.(\w+)/` would count the token wherever it appears — including the prose
// above the import, which already discusses these regions by name. A future edit that deletes
// `class={DOCK_SELECTORS.launcher}` while mentioning it in a comment would then keep this
// green while `resolveDock` throws for every reader: the check would be measuring that the
// page TALKS about a region, not that it authors one [LAW:verifiable-goals].
const referencedRegions = new Set(
  [...markup.matchAll(/class=\{[^\n]*?DOCK_SELECTORS\.(\w+)\b/g)].map(([, region]) => region ?? ""),
);
// The extraction has to find references at all, or every assertion below passes vacuously.
assert("the page interpolates the dock's selectors at all", referencedRegions.size > 0);
assert("a fictional region is not among them", !referencedRegions.has("noSuchRegion"));
for (const region of Object.keys(DOCK_SELECTORS)) {
  assert(`the ${region} region is authored in the page's markup`, referencedRegions.has(region));
}

console.log("\nEvery region the dock resolves is a class the stylesheet still styles:");

// [LAW:one-source-of-truth] global.css is the THIRD spelling of these names, and the only one
// that cannot follow a rename on its own — CSS has no way to import a TS constant, so where the
// template got interpolation this file gets a machine that re-reads it.
//
// Interpolating the template made this necessary rather than optional. Before it, a rename in
// DOCK_SELECTORS left the markup's literals stale and the old scrape failed loudly, putting a
// developer in front of every spelling at once. Now the markup and `resolveDock` follow a
// rename automatically and the stylesheet is the one place that silently does not — the dock
// would keep working and render entirely unstyled, with nothing red anywhere. Guarding the near
// half of a two-ended coupling and leaving the far half open is worse than not having moved.
//
// The boundary matters: `.tool-dock` must not be satisfied by `.tool-dock-scrim`. A substring
// test would pass on the prefix and be worth nothing for the exact rename this exists to catch.
// Matched against the stylesheet's SELECTORS, not its prose. `.tool-dock-panels` is already
// named in an explanatory comment (global.css:385) as well as in its real rules — so a raw
// match would keep reporting the class "styled" after the rules themselves were deleted,
// reading a name out of the commentary that explains them. That is the same silent drift this
// block exists to catch, arriving through the file's own documentation.
const styles = css.replace(/\/\*[\s\S]*?\*\//g, "");
const styledAsClass = (cls: string): boolean => new RegExp(`\\.${cls}(?![\\w-])`).test(styles);
assert("the stylesheet is readable and non-empty", styles.length > 0);
assert("a fictional class is not styled", !styledAsClass("no-such-region"));
for (const [region, cls] of Object.entries(DOCK_SELECTORS)) {
  assert(`the ${region} region's class ".${cls}" is styled in global.css`, styledAsClass(cls));
}

console.log("\nEvery tool in the list has a panel authored for it:");

// The two halves of a tool are generated differently: the bar item falls out of
// `dockTools` automatically, but the panel is a hand-authored section per tool. The
// compiler cannot see the gap — a tool whose `present` entry is true with no panel block
// type-checks clean. The dock script does catch it, but only in a browser, and its
// bijection assert throws BEFORE `tool-dock-ready` is added, so one missing panel takes
// down the whole dock for every tool rather than failing where it was introduced.
// The class is matched as an INTERPOLATION of `DOCK_SELECTORS.panel` rather than as a literal
// string, because that is what the template now authors. It stays loose enough to admit a
// panel carrying its own extra class beside the shared one (the versions panel is
// `` `${DOCK_SELECTORS.panel} version-trail` ``); a tighter match would silently drop that
// panel from this set — reporting a missing panel for a tool that has one, which is a false
// alarm that teaches the next reader to distrust the check.
const panelTools = new Set(
  captured(
    /class=\{[^\n]*?DOCK_SELECTORS\.panel\b[^\n]*?\}[\s\S]{0,240}?data-tool=\{TOOL\.(\w+)\.id\}/g,
  ),
);
// A plain string set to compare against: `ids` is ToolId[], and asking it about an
// arbitrary scraped string is exactly the question this check exists to ask.
const declaredIds = new Set<string>(ids);
// The extraction has to find panels at all, or every assertion below passes vacuously.
assert("the page authors tool panels this check can see", panelTools.size > 0);
for (const tool of DOCK_TOOLS) {
  assert(`${tool.id} has a panel <section> of its own`, panelTools.has(tool.id));
}
// A panel for a tool the list does not carry is the same bijection broken from the other
// side — it would reach the page as a panel no bar item can ever open.
for (const id of panelTools) {
  assert(`the "${id}" panel belongs to a tool in DOCK_TOOLS`, declaredIds.has(id));
}

if (process.exitCode) {
  console.error("\nTool dock checks FAILED.");
} else {
  console.log("\nAll tool dock checks passed.");
}
