// [LAW:one-source-of-truth] The code-artifact projection: a total, inert function
// from the stored Turn[] to a typed CodeArtifact union, computed at render time and
// storing NOTHING new — the same derived-projection shape as spineOutline.ts and
// deriveDialogue. [LAW:carrying-cost] It re-derives for every existing paste for
// free; a display change here is a renderer edit, never a migration.
// [LAW:one-way-deps] artifacts depends on types (Turn), toolCall (the JSON-vs-raw
// classifier + the file-path key table), and render (the fenced-block detector);
// none of them depends on artifacts.
//
// ─── THE ACCEPT / REJECT SHAPE TABLE (the classifier's spec) ─────────────────
// The extractor is a classifier, so its correctness is the table it satisfies, not
// its body [LAW:types-are-the-program]. Two honesty boundaries drive every row; a
// fabricated file is a missed-leak-class defect, so a case we cannot honestly
// represent is REJECTED, never papered over [LAW:no-silent-failure].
//
//   BOUNDARY 1 — FIDELITY BY TOOL. A file's whole content is knowable only from
//   Write (args.content) or Read (output.text). Edit/MultiEdit carry only an
//   old->new DIFF. So a file node is a union: full-content vs diff-only. We NEVER
//   synthesize a whole file by applying a diff to nothing.
//
//   BOUNDARY 2 — FIDELITY BY FORMAT. Structured args exist only for claude-jsonl
//   origin; claude-share/cc condense tool-calls to raw prose (parseJsonObject ->
//   null). So structured file extraction is a jsonl capability; a raw-text
//   tool-call yields no file artifact. Fenced code in prose is format-agnostic.
//
//   The verbatim per-row table lives in scripts/artifacts-check.ts and IS the test.
//
// ─── Turn kind -> contribution ──────────────────────────────────────────────
//   message | thinking | insight  -> fenced code blocks in the prose  -> snippet
//   tool-call                     -> a file operation (see below) or nothing
//   subagent (captured)           -> RECURSE into the nested transcript
//   subagent (summary-only)       -> nothing (degraded capture: no structured turns)
//   turn-summary | usage          -> nothing (derived annotations, no authored code)
//
// ─── tool-call -> file operation ────────────────────────────────────────────
//   Write     JSON {file_path, content:str}                -> full(content)
//   Read      JSON {file_path}  + non-null output          -> full(output.text)
//   Read      JSON {file_path}  + null output              -> REJECT (no content)
//   Edit      JSON {file_path, old_string, new_string}     -> diff([{old,new}])
//   MultiEdit JSON {file_path, edits:[{old_string,new_string}]} -> diff(edits)
//   <file tool> args are RAW TEXT (parseJsonObject null)   -> REJECT (fmt boundary)
//   <file tool> JSON, file_path missing/non-string/empty   -> REJECT (no honest path)
//   Write     JSON but content missing/non-string          -> REJECT (no content)
//   Edit      JSON but old_string/new_string missing        -> REJECT (no diff)
//   NotebookEdit                                            -> REJECT (a single
//     cell's new_source is neither a whole file nor an old->new diff; rendering it
//     as either would fabricate — the honest classification is "no file artifact")
//   Bash | Grep | Glob | Task | WebFetch | ... | unknown   -> REJECT (not a file tool)
//
// ─── per-path aggregation (across every accepted op for one path) ────────────
//   >=1 full op (Write/Read) -> full(LAST full snapshot in source order)
//   only diff ops            -> diff(all edits, source order)
//   (a path exists only when >=1 op was accepted, so resolution is total)
//
// ─── fenced block -> snippet ────────────────────────────────────────────────
//   fenced ```lang, non-empty text  -> snippet(lang = first info word)
//   fenced bare ```, non-empty text -> snippet(lang = null)
//   fenced with empty text          -> REJECT (zero bytes: nothing to copy/download)
//   indented (4-space) code block   -> REJECT (no fence; out of the ``` scope)
//   inline codespan `x`             -> REJECT (not a block)

import type { Turn, ToolOutput } from "./types";
import { parseJsonObject, TOOL_PRIMARY_ARG, type JsonObject } from "./toolCall";
import { fencedCodeBlocks } from "./render";

// [LAW:types-are-the-program] One edit is an old->new pair — the exact diff an Edit
// stores. Neither side is optional: an edit missing either half is not a diff, so
// it is not representable here (the reader rejects it upstream).
export interface FileEdit {
  readonly old: string;
  readonly new: string;
}

// [LAW:types-are-the-program] A file's content at the fidelity we can HONESTLY
// know it. `full` is a verbatim whole-file snapshot that actually existed (a Write
// we watched, or a Read of the file). `diff` is the set of old->new edits with NO
// whole-file base — the reconstruction is deliberately withheld, because applying
// a diff to nothing would fabricate a file that never existed [LAW:no-silent-failure].
export type FileContent =
  | { readonly kind: "full"; readonly text: string }
  | { readonly kind: "diff"; readonly edits: ReadonlyArray<FileEdit> };

// [LAW:types-are-the-program] The two honest kinds of extracted artifact. A
// `snippet` is fenced code from prose — format-agnostic, path-less, a loose block.
// A `file` is a reconstructed tree node — it has a path and a fidelity. Illegal
// mixtures (a path-less file, a snippet with a diff) are unrepresentable.
export type CodeArtifact =
  | { readonly kind: "snippet"; readonly lang: string | null; readonly text: string }
  | { readonly kind: "file"; readonly path: string; readonly content: FileContent };

// The value read from a tool-call's structured args before per-path aggregation:
// either a whole-file snapshot or one-or-more edits. Internal to the fold.
type FileOp =
  | { readonly fidelity: "full"; readonly text: string }
  | { readonly fidelity: "diff"; readonly edits: ReadonlyArray<FileEdit> };

// obj[key] iff it is a string, else null — the trust-boundary read over untrusted
// parsed JSON [LAW:no-defensive-null-guards]: absence and wrong-type collapse to the
// one honest "not present as a string" outcome the callers branch on as a value.
const strField = (obj: JsonObject, key: string): string | null => {
  const v = obj[key];
  return typeof v === "string" ? v : null;
};

const readEdit = (obj: JsonObject): FileEdit | null => {
  const oldStr = strField(obj, "old_string");
  const newStr = strField(obj, "new_string");
  return oldStr === null || newStr === null ? null : { old: oldStr, new: newStr };
};

// MultiEdit's `edits` is an array of {old_string,new_string}. Every entry must be a
// well-formed pair; a malformed edits array yields null (reject the whole call)
// rather than a partial diff that silently drops edits [LAW:no-silent-failure].
const readEdits = (obj: JsonObject): ReadonlyArray<FileEdit> | null => {
  const raw = obj["edits"];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const edits: FileEdit[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") return null;
    const e = readEdit(entry as JsonObject);
    if (e === null) return null;
    edits.push(e);
  }
  return edits;
};

// [LAW:dataflow-not-control-flow] The whole per-file-tool CONTENT behavior lives in
// ONE table: tool -> the pure function that turns its structured args (+result)
// into a FileOp, or null when the honest content/diff is absent. The file-path KEY
// is NOT duplicated here — it is read from TOOL_PRIMARY_ARG [LAW:single-enforcer].
// A tool ABSENT from this table yields no file artifact (Bash, Grep, NotebookEdit,
// unknown tools) — adding file support for a tool is adding a row, never a branch.
type FileExtractor = (obj: JsonObject, output: ToolOutput | null) => FileOp | null;

const FILE_EXTRACTORS: { readonly [tool: string]: FileExtractor } = {
  // The final content being written IS the whole file. [BOUNDARY 1: full]
  Write: (obj) => {
    const text = strField(obj, "content");
    return text === null ? null : { fidelity: "full", text };
  },
  // A Read's content lives in its RESULT, never its args; a Read with no captured
  // output knows no content, so it produces no file. [BOUNDARY 1: full]
  Read: (_obj, output) => (output === null ? null : { fidelity: "full", text: output.text }),
  // An Edit carries only an old->new diff; never the whole file. [BOUNDARY 1: diff]
  Edit: (obj) => {
    const edit = readEdit(obj);
    return edit === null ? null : { fidelity: "diff", edits: [edit] };
  },
  MultiEdit: (obj) => {
    const edits = readEdits(obj);
    return edits === null ? null : { fidelity: "diff", edits };
  },
};

// The per-path accumulator: the last whole-file snapshot seen (null until a
// Write/Read supplies one) and every edit seen, in source order. A path enters the
// map only when an op is accepted, so at resolution one of the two is always present.
interface PathAcc {
  fullText: string | null;
  readonly edits: FileEdit[];
}

const resolvePath = (acc: PathAcc): FileContent =>
  acc.fullText !== null
    ? { kind: "full", text: acc.fullText }
    : { kind: "diff", edits: acc.edits };

// Classify ONE tool-call turn into a FileOp for a path, or null to reject. Threads
// the two honesty boundaries: the FORMAT boundary (parseJsonObject) then the TOOL
// boundary (FILE_EXTRACTORS + the path key). Returns null for every rejected row.
const fileOpOf = (
  tool: string,
  args: string,
  output: ToolOutput | null,
): { readonly path: string; readonly op: FileOp } | null => {
  const extractor = FILE_EXTRACTORS[tool];
  if (extractor === undefined) return null; // not a file tool
  const obj = parseJsonObject(args);
  if (obj === null) return null; // FORMAT boundary: raw-text (cc/share) tool-call
  const pathKey = TOOL_PRIMARY_ARG[tool]; // "file_path" for every file tool
  const path = pathKey === undefined ? null : strField(obj, pathKey);
  // A path must be a NON-EMPTY string. Emptiness is rejected here, not in strField,
  // because an empty `content` (a Write of an empty file) or an empty `old_string`
  // (an insert-Edit) are legitimate — only a pathless file is nonsensical.
  if (path === null || path.length === 0) return null; // no honest path
  const op = extractor(obj, output);
  return op === null ? null : { path, op };
};

// [LAW:dataflow-not-control-flow] A single in-source-order fold over the flat Turn
// stream — the same shape as deriveDialogue. Snippets append in source order;
// file ops aggregate into a path-keyed map whose insertion order is first-seen path
// order. A captured subagent turn recurses in place, so its files/snippets fold into
// the SAME aggregation at the point the subagent ran — one flat working tree.
const fold = (
  turns: ReadonlyArray<Turn>,
  snippets: CodeArtifact[],
  files: Map<string, PathAcc>,
): void => {
  const accept = (path: string, op: FileOp): void => {
    let acc = files.get(path);
    if (acc === undefined) {
      acc = { fullText: null, edits: [] };
      files.set(path, acc);
    }
    if (op.fidelity === "full") acc.fullText = op.text; // last full snapshot wins
    else acc.edits.push(...op.edits);
  };

  for (const turn of turns) {
    switch (turn.kind) {
      case "message":
      case "thinking":
      case "insight":
        // message/thinking/insight all carry prose in `content`; a zero-byte fenced
        // block is not an artifact (nothing to copy/download) so it is dropped here.
        for (const block of fencedCodeBlocks(turn.content)) {
          if (block.text.length > 0) {
            snippets.push({ kind: "snippet", lang: block.lang, text: block.text });
          }
        }
        break;
      case "tool-call": {
        const found = fileOpOf(turn.tool, turn.args, turn.output);
        if (found !== null) accept(found.path, found.op);
        break;
      }
      case "subagent":
        if (turn.transcript.kind === "captured") fold(turn.transcript.turns, snippets, files);
        break;
      case "turn-summary":
      case "usage":
        break;
    }
  }
};

// [LAW:types-are-the-program] The projection: files first (first-seen path order,
// a mini file tree), then snippets (source order). Grouping by kind is deliberate —
// .3/.4 present a file tree and loose code blocks through different affordances.
export const extractArtifacts = (turns: ReadonlyArray<Turn>): ReadonlyArray<CodeArtifact> => {
  const snippets: CodeArtifact[] = [];
  const files = new Map<string, PathAcc>();
  fold(turns, snippets, files);
  const fileArtifacts: CodeArtifact[] = [];
  for (const [path, acc] of files) {
    fileArtifacts.push({ kind: "file", path, content: resolvePath(acc) });
  }
  return [...fileArtifacts, ...snippets];
};
