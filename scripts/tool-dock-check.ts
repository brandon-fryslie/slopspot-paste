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
// The question is whether the page NAMES the class, not how it applies it: two of them
// arrive through a shared wirePayloadCopy(…, readyClass) call rather than an inline
// classList.add, and a check that only recognised one spelling would be asserting the
// shape of the code instead of the fact [LAW:behavior-not-structure].
const names = (cls: string): boolean => page.includes(`"${cls}"`);
assert("the paste page names capability classes at all", names("search-ready"));
// A class no tool script has ever heard of must fail, or this check proves nothing.
assert("a fictional class is not found", !names("no-such-tool-ready"));
for (const tool of DOCK_TOOLS) {
  const a = tool.availability;
  if (a.kind === "always") continue;
  for (const cls of a.bodyClasses) {
    assert(`${tool.id} is gated on body.${cls}, which the page names`, names(cls));
  }
}

if (process.exitCode) {
  console.error("\nTool dock checks FAILED.");
} else {
  console.log("\nAll tool dock checks passed.");
}
