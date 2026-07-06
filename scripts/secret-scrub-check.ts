// Pre-publish scrub checks (slopspot-secret-guard-4zw.4). Run: `tsx scripts/secret-scrub-check.ts`.
//
// No framework — asserts and sets a non-zero exit code on failure. secret-check.ts proves the
// scanner; secret-warnings-check.ts proves the warn projection; THIS file proves the SCRUB — the
// true removal the author triggers, which must remove from what is STORED, not merely hide on
// display. The load-bearing claims [LAW:verifiable-goals]:
//   - THE INVARIANT: after scrubbing, re-scanning finds NOTHING — scrub-surface >= scan-surface,
//     so a warned secret is a removed secret (no silent partial redaction [LAW:no-silent-failure]);
//   - the surrounding, non-secret text is preserved (a scrub is surgical, not a nuke);
//   - the scrub covers every field the warn scan covers: prose, turn-summary, tool tool/args/output;
//   - scrubOrigin strips the raw text every reproject source arm carries (content / url.fetched /
//     the preserved editor `input`), so a display can never resurrect the secret from the origin;
//   - the marker is INERT and scrub is IDEMPOTENT (scrubbing twice == once);
//   - overlapping findings fold into ONE marker.
//
// Secret values are synthetic but shaped like the real producers. None is a live credential.

import { scrubText, scrubOrigin, scrubTurn, mergeFindings } from "../src/secret-scrub";
import { type AuthorableTurn } from "../src/editor/blocks";
import { scanSecrets } from "../src/secret-scan";
import { scanTurnsForSecrets } from "../src/secret-warnings";
import type { Origin, ReplayableOrigin } from "../src/types";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const clean = (s: string): boolean => scanSecrets(s).length === 0;

// Shaped-but-synthetic secrets reused across cases.
const AWS = "AKIAIOSFODNN7EXAMPLE";
const OPENAI = "sk-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKL";
const EMAIL = "jane.doe@gmail.com";

console.log("secret-scrub: scrubText removes a shaped secret and the result scans clean");
{
  const src = `here is the key ${OPENAI} keep the rest`;
  const out = scrubText(src);
  assert("the secret bytes are gone", !out.includes(OPENAI));
  assert("the scrubbed text scans clean", clean(out));
  assert("surrounding prose is preserved", out.startsWith("here is the key ") && out.endsWith(" keep the rest"));
  assert("a marker naming the kind is inserted", out.includes("[redacted OpenAI API key]"));
}

console.log("secret-scrub: clean text is returned untouched");
{
  const src = "no secrets here, just ordinary prose with user@example.com from the docs";
  assert("identical string back (no findings -> no splice)", scrubText(src) === src);
}

console.log("secret-scrub: scrub is idempotent and the marker is inert");
{
  const once = scrubText(`key ${OPENAI} and mail ${EMAIL}`);
  assert("scrubbing twice equals scrubbing once", scrubText(once) === once);
  assert("the marker itself carries no scannable secret", clean(once));
}

console.log("secret-scrub: multiple distinct secrets each get their own marker, separator kept");
{
  // scanSecrets output is ALWAYS disjoint (the anchored patterns' word boundaries mean two
  // secrets are either separated or collapse into one match — abutment is unconstructable), so
  // two space-separated secrets are two findings that do NOT merge: each becomes its own marker
  // and the text between them is preserved unmangled. This is scrubText's observable contract;
  // the merge fold itself is unreachable here and is tested directly below.
  const out = scrubText(`${EMAIL} ${OPENAI}`);
  assert("no secret bytes remain", !out.includes(EMAIL) && !out.includes(OPENAI));
  assert("scans clean", clean(out));
  const markers = out.match(/\[redacted [^\]]+\]/g) ?? [];
  assert("two distinct secrets -> two markers", markers.length === 2);
  assert("separator preserved, order + markers exact", out === "[redacted email address] [redacted OpenAI API key]");
}

console.log("secret-scrub: mergeFindings folds overlapping/abutting ranges into one redaction");
{
  // The scanner cannot emit overlaps, so this fold arm (secret-scrub.ts `f.start <= last.end`)
  // is coverable only by feeding mergeFindings ranges directly — the defensive case a future
  // rule that CAN overlap would hit. mergeFindings sorts internally, so no input-order
  // precondition (the unsorted case is asserted below).
  const overlap = mergeFindings([
    { kind: "openai-key", start: 0, end: 10 },
    { kind: "email", start: 5, end: 15 },
  ]);
  assert("overlapping ranges fold to one", overlap.length === 1);
  assert("folded range is the union [0,15)", overlap[0]?.start === 0 && overlap[0]?.end === 15);
  assert("folded range carries both kinds, deduped in order", overlap[0]?.kinds.join(",") === "openai-key,email");

  const abut = mergeFindings([
    { kind: "email", start: 0, end: 5 },
    { kind: "email", start: 5, end: 9 },
  ]);
  assert("abutting ranges (start == prev.end) fold to one", abut.length === 1 && abut[0]?.end === 9);
  assert("same kind is not duplicated on the folded range", abut[0]?.kinds.length === 1);

  const disjoint = mergeFindings([
    { kind: "email", start: 0, end: 5 },
    { kind: "email", start: 6, end: 9 },
  ]);
  assert("a gap keeps ranges separate", disjoint.length === 2);

  // Unsorted input must NOT spuriously merge: mergeFindings sorts first, so two disjoint ranges
  // given out of order stay two ranges (a naive `f.start <= last.end` over unsorted input would
  // fold [10,15) into [0,5)). This proves the no-silent-failure fix.
  const unsorted = mergeFindings([
    { kind: "email", start: 10, end: 15 },
    { kind: "openai-key", start: 0, end: 5 },
  ]);
  assert("unsorted disjoint input stays two ranges, in sorted order", unsorted.length === 2 && unsorted[0]?.start === 0 && unsorted[1]?.start === 10);
}

console.log("secret-scrub: scrubTurn covers every warn-scanned field (prose, summary, tool-call)");
{
  const turns: AuthorableTurn[] = [
    { kind: "message", role: "user", content: `msg secret ${OPENAI}` },
    { kind: "insight", content: `insight ${EMAIL}` },
    { kind: "thinking", content: `thinking ${AWS}` },
    { kind: "turn-summary", text: `summary ${OPENAI}` },
    { kind: "tool-call", tool: `tool-${AWS}`, args: `args ${OPENAI}`, output: { kind: "terminal", text: `OUT ${EMAIL}`, isError: false } },
  ];
  // THE INVARIANT: scrub every turn, then the warn scan must find nothing anywhere.
  const scrubbed = turns.map(scrubTurn);
  assert("scrub-then-scan finds NOTHING across all fields", scanTurnsForSecrets(scrubbed).length === 0);
  // Field-level spot checks that the non-secret parts survived.
  const tool = scrubbed[4];
  assert("tool-call kind + shape preserved", tool?.kind === "tool-call" && tool.output !== null);
}

console.log("secret-scrub: a scrub is a content edit, never a kind/shape change");
{
  const turn: AuthorableTurn = { kind: "tool-call", tool: "Bash", args: `aws set ${AWS}`, output: null };
  const out = scrubTurn(turn);
  assert("kind unchanged", out.kind === "tool-call");
  assert("null output stays null", out.kind === "tool-call" && out.output === null);
  assert("non-secret field (tool) preserved", out.kind === "tool-call" && out.tool === "Bash");
}

console.log("secret-scrub: scrubOrigin strips every reproject-source arm");
{
  const text: Origin = { kind: "markdown", content: `raw md with ${OPENAI}` };
  const url: Origin = { kind: "url", url: "https://ex.com/x", fetched: `body ${AWS}`, provider: null };
  const editorWithInput: Origin = {
    kind: "editor",
    source: "markdown",
    input: { kind: "markdown", content: `preserved import ${EMAIL}` } satisfies ReplayableOrigin,
  };
  const editorScratch: Origin = { kind: "editor", source: null };

  const st = scrubOrigin(text);
  assert("text arm content scrubbed clean", st.kind === "markdown" && clean(st.content) && !st.content.includes(OPENAI));

  const su = scrubOrigin(url);
  assert("url arm fetched scrubbed clean", su.kind === "url" && clean(su.fetched) && !su.fetched.includes(AWS));
  assert("url link itself is preserved (not a secret)", su.kind === "url" && su.url === "https://ex.com/x");

  const se = scrubOrigin(editorWithInput);
  const input = se.kind === "editor" ? se.input : undefined;
  assert("preserved editor input scrubbed clean", input !== undefined && input.kind === "markdown" && clean(input.content));
  assert("preserved input secret bytes gone", input !== undefined && input.kind === "markdown" && !input.content.includes(EMAIL));

  const ss = scrubOrigin(editorScratch);
  assert("from-scratch editor origin (no input) is returned untouched", ss === editorScratch);
}

console.log("secret-scrub complete");
