// Citation-linkification checks (slopspot-ask-rag-a3k.6, PR #108 review). Run:
// `tsx scripts/answer-citations-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure.
// [LAW:verifiable-goals] answerNodes is the reader page's
// linkify-only-certified-citations guard; this drives it against a real jsdom
// Document with the inputs that matter: cited tags, uncited tags (the
// hallucination case), malformed tags, consecutive and duplicate tags, and an
// answer carrying markup (which must land as text, never elements).
// [LAW:behavior-not-structure] Assertions read the produced DOM — node types,
// hrefs, rendered text — never the function's internals.

import { JSDOM } from "jsdom";
import { answerNodes, type CitedTurn } from "../src/answerCitations";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const assertEq = <T,>(label: string, actual: T, expected: T): void => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    console.error(`    expected: ${e}`);
    console.error(`    actual:   ${a}`);
    process.exitCode = 1;
  }
};

const doc = new JSDOM("<!DOCTYPE html>").window.document;

// Mount the nodes the way the page does (appendChild into a container), then
// assert on the resulting DOM.
const mount = (answer: string, citations: ReadonlyArray<CitedTurn>): HTMLElement => {
  const p = doc.createElement("p");
  for (const node of answerNodes(doc, answer, citations)) p.appendChild(node);
  return p;
};

const t4: CitedTurn = { index: 4, anchor: "t4", label: "the fix was reordering middleware" };
const t7: CitedTurn = { index: 7, anchor: "t7", label: "inject the effect" };

console.log("A certified tag becomes a jump link; surrounding prose stays text:");
{
  const p = mount("The fix was to reorder the middleware [t4]. Done.", [t4]);
  const links = [...p.querySelectorAll("a")];
  assertEq("exactly one link is produced", links.length, 1);
  assertEq("the link jumps to the renderer's anchor", links[0]?.getAttribute("href"), "#t4");
  assertEq("the link text is the tag itself", links[0]?.textContent, "[t4]");
  assertEq("the link carries the turn label as its title", links[0]?.getAttribute("title"), t4.label);
  assertEq("the link wears the ask-cite class", links[0]?.className, "ask-cite");
  assertEq("the rendered text is the whole answer, unaltered", p.textContent,
    "The fix was to reorder the middleware [t4]. Done.");
}

console.log("\nAn uncited tag — the hallucination case — stays plain text:");
{
  const p = mount("Supported [t4] but also [t99] says so.", [t4]);
  assertEq("only the certified tag links", [...p.querySelectorAll("a")].map((a) => a.textContent), ["[t4]"]);
  assert("the uncited tag survives as text, not a dead link", (p.textContent ?? "").includes("[t99]"));
}

console.log("\nMalformed tags never link:");
{
  const p = mount("None of [tx], [t], [ t4 ], [t4.5], or t4 link.", [t4]);
  assertEq("no links from malformed tags", p.querySelectorAll("a").length, 0);
  assertEq("the text is untouched", p.textContent, "None of [tx], [t], [ t4 ], [t4.5], or t4 link.");
}

console.log("\nConsecutive and duplicate tags each linkify:");
{
  const p = mount("See [t4][t7] and again [t4].", [t4, t7]);
  assertEq("all three tags link, in order",
    [...p.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["#t4", "#t7", "#t4"]);
}

console.log("\nMarkup in the answer lands as text, never elements:");
{
  const p = mount('<img src=x onerror="alert(1)"> is what t-he model said [t4]', [t4]);
  assertEq("no element other than the citation link exists", p.querySelectorAll("*").length, 1);
  assert("the markup is escaped text in the DOM", p.innerHTML.includes("&lt;img"));
  assert("the raw text survives verbatim", (p.textContent ?? "").startsWith('<img src=x onerror="alert(1)">'));
}

console.log("\nNo citations means no links at all:");
{
  const p = mount("An answer citing [t4] that the server certified nothing for.", []);
  assertEq("zero links", p.querySelectorAll("a").length, 0);
}
