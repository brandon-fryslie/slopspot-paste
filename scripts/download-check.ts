// Download-as-files check (slopspot-code-export-i0g.4). Two seams under test:
//
//  1. downloadTree(CodeArtifact[]) -> ZipEntry[]  — the HONESTY MAPPING. Its contract
//     is the accept table below; a diff-only file must NEVER become a real file, only a
//     patch [LAW:no-silent-failure]. Asserted on direct CodeArtifact fixtures so the
//     mapping is tested in isolation [LAW:behavior-not-structure].
//
//  2. zipArchive(ZipEntry[]) -> Uint8Array  — the ENCODER. Validated end-to-end by the
//     real system `unzip`: the produced bytes must pass CRC integrity (-t) and a full
//     file's bytes must round-trip through extraction (-p) [LAW:verifiable-goals]. A
//     hand-rolled zip that some unzipper rejects is a silent lie; the external,
//     independent decoder is the deterministic proof it is a valid archive.
//
// ─── downloadTree ACCEPT TABLE (the mapping's spec) ──────────────────────────
//   file, content=full   -> ZipEntry at the safe real path, VERBATIM bytes (a real file)
//   file, content=diff    -> ZipEntry under patches/<safe path>.patch, labelled edit text
//                            (NO entry at the real path — a diff is never a whole file)
//   snippet, lang=<known> -> snippets/snippet-NNN.<ext>, verbatim text
//   snippet, lang=null    -> snippets/snippet-NNN.txt, verbatim text
//   absolute path "/a/b"  -> "a/b" (leading root stripped; zip-slip-safe, tree preserved)
//   order                 -> artifact order preserved (files first, then snippets)

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadTree } from "../src/codeExport";
import { zipArchive } from "../src/zip";
import type { CodeArtifact } from "../src/artifacts";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// ── fixtures: one of every artifact shape, files first then snippets ──────────
const FULL_TEXT = "export const x = 1;\n// a line with unicode: café ☕\n";
const artifacts: ReadonlyArray<CodeArtifact> = [
  { kind: "file", path: "/Users/x/proj/src/foo.ts", content: { kind: "full", text: FULL_TEXT } },
  { kind: "file", path: "src/bar.ts", content: { kind: "diff", edits: [{ old: "const a = 1;", new: "const a = 2;" }] } },
  { kind: "snippet", lang: "typescript", text: "const y: number = 2;" },
  { kind: "snippet", lang: null, text: "just some prose in a bare fence" },
];

const tree = downloadTree(artifacts);
const byPath = new Map(tree.map((e) => [e.path, e]));

console.log("downloadTree mapping:");
// full file -> real (safe) path, verbatim bytes. Absolute root stripped, nesting kept.
assert("full file lands at safe real path (leading / stripped)", byPath.has("Users/x/proj/src/foo.ts"));
assert("full file bytes are verbatim", byPath.get("Users/x/proj/src/foo.ts")?.text === FULL_TEXT);

// diff-only file -> a patch, NEVER a real file.
assert("diff-only file is NOT emitted at its real path", !byPath.has("src/bar.ts"));
assert("diff-only file lands under patches/ with .patch suffix", byPath.has("patches/src/bar.ts.patch"));
const patch = byPath.get("patches/src/bar.ts.patch")?.text ?? "";
assert("patch is labelled a diff-only file (no fabricated whole file)", patch.includes("diff-only file"));
assert("patch carries the old->new replacement honestly", patch.includes("const a = 1;") && patch.includes("const a = 2;"));

// snippets -> numbered bucket, extension derived from lang (or .txt).
assert("known-lang snippet -> snippets/snippet-001.ts", byPath.get("snippets/snippet-001.ts")?.text === "const y: number = 2;");
assert("bare snippet -> snippets/snippet-002.txt", byPath.get("snippets/snippet-002.txt")?.text === "just some prose in a bare fence");

// order preserved: files first, then snippets in source order.
assert(
  "entry order is files-first then snippets",
  tree.map((e) => e.path).join("|") ===
    "Users/x/proj/src/foo.ts|patches/src/bar.ts.patch|snippets/snippet-001.ts|snippets/snippet-002.txt",
);

// empty in -> empty tree (a value, not a special case).
assert("empty artifacts -> empty tree", downloadTree([]).length === 0);

// ── robustness: no empty-named and no colliding archive members ───────────────
console.log("downloadTree robustness (non-empty + unique names):");
// A degenerate all-root/traversal path names no real location -> a stable non-empty
// placeholder, never an empty-named archive member.
const rootTree = downloadTree([{ kind: "file", path: "/", content: { kind: "full", text: "x" } }]);
assert("degenerate '/' path -> non-empty placeholder entry", rootTree.length === 1 && rootTree[0]!.path.length > 0);

// A real file colliding with a generated bucket path must NOT silently overwrite it:
// files are emitted first, so the real file keeps its name and the later generated entry
// is suffixed. Here a real full file sits at the exact path a snippet would take.
const collide = downloadTree([
  { kind: "file", path: "snippets/snippet-001.ts", content: { kind: "full", text: "REAL FILE" } },
  { kind: "snippet", lang: "typescript", text: "GENERATED SNIPPET" },
]);
const collidePaths = collide.map((e) => e.path);
assert("collision: real file keeps its name", collide[0]?.path === "snippets/snippet-001.ts" && collide[0]?.text === "REAL FILE");
assert("collision: generated entry is renamed, not dropped", collidePaths.length === 2 && new Set(collidePaths).size === 2);
assert("collision: rename keeps the extension (…-1.ts)", collidePaths[1] === "snippets/snippet-001-1.ts" && collide[1]?.text === "GENERATED SNIPPET");

// ── zipArchive: validate the real bytes with the system unzip ─────────────────
console.log("zipArchive validity (system unzip):");
const bytes = zipArchive(tree);
const dir = mkdtempSync(join(tmpdir(), "slopspot-zip-"));
const zipPath = join(dir, "code.zip");
try {
  writeFileSync(zipPath, bytes);

  // -t: CRC-32 + structural integrity across every entry. Throws (nonzero) on any
  // corruption, which surfaces as a loud failure here [LAW:no-silent-failure].
  const test = execFileSync("unzip", ["-t", zipPath], { encoding: "utf8" });
  assert("unzip -t reports no errors (CRCs + structure valid)", test.includes("No errors detected"));

  // -Z1: every mapped entry name is present in the archive's central directory.
  const listed = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.length > 0)
    .sort();
  const expected = tree.map((e) => e.path).sort();
  assert("archive lists exactly the mapped entries", listed.join("|") === expected.join("|"));

  // -p: a full file's bytes round-trip through extraction, byte-for-byte (incl. unicode).
  const extracted = execFileSync("unzip", ["-p", zipPath, "Users/x/proj/src/foo.ts"], { encoding: "utf8" });
  assert("extracted full file equals the original bytes", extracted === FULL_TEXT);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
