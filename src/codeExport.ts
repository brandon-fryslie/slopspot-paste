// [LAW:decomposition] The .3 PRESENTATION of extracted artifacts: a pure formatter
// (CodeArtifact[] -> one legible clipboard payload) and the document-scoped control
// markup that carries it. Kept apart from artifacts.ts (the extractor: model ->
// CodeArtifact[]) so the two concerns compose independently — .4 adds a file-tree
// presentation here beside this one, never by re-shaping the extractor.
//
// [LAW:one-way-deps] codeExport depends on artifacts (the union) and render (HTML
// escaping); neither depends back on it.
// [LAW:effects-at-boundaries] Both functions are pure string builders. The clipboard
// write and the reveal are the page's client concern, not this module's.

import type { CodeArtifact, FileContent, FileEdit } from "./artifacts";
import { zipArchive, type ZipEntry } from "./zip";
import { escapeHtml } from "./render";

// [LAW:one-source-of-truth] One pluralizer for the control labels, so "1 block" /
// "3 blocks" is decided in a single place, not re-inlined per label.
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

// One old->new replacement, rendered verbatim under labels. [LAW:no-silent-failure]
// A diff is shown AS a diff — the old text and the new text, each labelled — never
// applied to fabricate a whole file that never existed.
const editText = (edit: FileEdit): string =>
  `--- replace ---\n${edit.old}\n--- with ---\n${edit.new}`;

// [LAW:dataflow-not-control-flow] The body of a file block is a projection of its
// FileContent value, one exhaustive switch: a full snapshot is its verbatim text; a
// diff-only file is a labelled note plus its replacements, honestly withholding the
// whole-file bytes we never had.
const fileBody = (content: FileContent): string => {
  switch (content.kind) {
    case "full":
      return content.text;
    case "diff": {
      const n = content.edits.length;
      const note = `[diff-only file — no full-file snapshot was captured; ${n} replacement${n === 1 ? "" : "s"} below]`;
      return `${note}\n${content.edits.map(editText).join("\n\n")}`;
    }
  }
};

// [LAW:dataflow-not-control-flow] Each artifact becomes one headed block — the header
// names its path (a file) or language (a snippet) so the concatenated paste is legible.
// One exhaustive switch over the union; a new kind is compiler-forced to declare its
// header here.
const artifactBlock = (artifact: CodeArtifact): string => {
  switch (artifact.kind) {
    case "file":
      return `===== ${artifact.path} =====\n${fileBody(artifact.content)}`;
    case "snippet":
      return `===== snippet${artifact.lang === null ? "" : " · " + artifact.lang} =====\n${artifact.text}`;
  }
};

// [LAW:one-source-of-truth] The single clipboard payload: every artifact's headed
// block, in the extractor's order (files first, then snippets), joined by a blank
// line. Plain text with delimiter headers — robust to code that itself contains
// backticks, unlike nested markdown fences. Empty in -> empty out; the control
// renderer below never emits a button for an empty payload.
export const formatCodeArtifacts = (artifacts: ReadonlyArray<CodeArtifact>): string =>
  artifacts.map(artifactBlock).join("\n\n");

// ─── .4 Download as files: the mini file tree as a zip ──────────────────────────

// [LAW:no-silent-failure] A zip entry's path must be a SAFE RELATIVE path inside the
// archive root: an absolute root ("/Users/…") or ".." traversal is stripped so
// extraction can never escape the extraction dir (zip-slip) and every file lands under
// one clean tree. This is honest normalization, not a lie about meaning — the real
// nesting under the path is preserved; only the leading root and traversal segments,
// which name no captured content, are dropped.
const safeTreePath = (path: string): string => {
  const safe = path
    .split("/")
    .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..")
    .join("/");
  // [LAW:types-are-the-program] The contract is a safe NON-EMPTY relative path: a
  // degenerate path that was all root/traversal segments ("/", ".", "///") names no real
  // location and strips to "", so it becomes a stable placeholder rather than an
  // empty-named archive member the downstream never has to guard against.
  return safe.length > 0 ? safe : "unnamed";
};

// [LAW:no-mode-explosion] A small, bounded fence-lang -> extension table so a downloaded
// snippet carries a real extension its editor recognizes. Data rows, not branches:
// adding a language is one entry, and anything absent (or a bare fence) falls to .txt —
// an honest default that never invents a wrong extension.
const SNIPPET_EXT: { readonly [lang: string]: string } = {
  typescript: "ts", ts: "ts", tsx: "tsx",
  javascript: "js", js: "js", jsx: "jsx",
  python: "py", py: "py",
  ruby: "rb", rb: "rb",
  go: "go", rust: "rs", rs: "rs",
  java: "java", kotlin: "kt", swift: "swift",
  c: "c", "c++": "cpp", cpp: "cpp", "c#": "cs", csharp: "cs",
  php: "php", sh: "sh", bash: "sh", shell: "sh", zsh: "sh",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
  html: "html", css: "css", scss: "scss", sql: "sql",
  markdown: "md", md: "md", xml: "xml", astro: "astro",
};

// [LAW:dataflow-not-control-flow] One file artifact -> its honest place in the tree,
// an exhaustive switch over the FileContent union. A `full` snapshot is a REAL
// reconstructed file at its (safe) path — verbatim bytes, no header. A `diff`-only file
// is NEVER fabricated into whole bytes: it lands under patches/ with a .patch suffix,
// carrying the SAME labelled edit text the copy-all payload shows [LAW:one-source-of-
// truth via fileBody] — a diff shown as a diff, honestly withholding the whole file we
// never had [LAW:no-silent-failure].
const fileEntry = (path: string, content: FileContent): ZipEntry => {
  switch (content.kind) {
    case "full":
      return { path: safeTreePath(path), text: content.text };
    case "diff":
      return { path: `patches/${safeTreePath(path)}.patch`, text: fileBody(content) };
  }
};

// A numeric suffix inserted before the final extension, so a renamed collision keeps its
// type: "src/app.ts" -> "src/app-1.ts", "Makefile" -> "Makefile-1". A dot counts as an
// extension separator only after the last slash and not as the segment's first char, so
// a dotfile ("patches/.gitignore.patch") stays whole rather than losing its name.
const suffixed = (path: string, n: number): string => {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash + 1 ? `${path.slice(0, dot)}-${n}${path.slice(dot)}` : `${path}-${n}`;
};

// [LAW:no-silent-failure] Guarantee every archive member name is DISTINCT, so no entry is
// silently overwritten on extraction — a real file whose path happens to equal a
// generated patches//snippets entry, or two paths that normalize alike, would otherwise
// clobber each other and lose content. Emission order is preserved (files first), so on a
// clash the real file keeps its name and the later generated entry is suffixed; real
// paths are never renamed away in favor of a synthetic one.
const uniquify = (entries: ReadonlyArray<ZipEntry>): ReadonlyArray<ZipEntry> => {
  const seen = new Set<string>();
  return entries.map((e) => {
    let path = e.path;
    for (let n = 1; seen.has(path); n += 1) path = suffixed(e.path, n);
    seen.add(path);
    return path === e.path ? e : { path, text: e.text };
  });
};

// [LAW:types-are-the-program] The download projection: the extractor's CodeArtifact[]
// mapped to the zip's members, preserving the extractor's order (reconstructed files
// first, then loose snippets). Full files become the real tree; diff-only files become
// patches/…; path-less snippets are bucketed under snippets/ and numbered in source
// order with a lang-derived extension. A final uniquify pass makes every entry name
// distinct. Every artifact yields exactly one honest entry, so an empty input is an
// empty tree (a value, not a special case).
export const downloadTree = (artifacts: ReadonlyArray<CodeArtifact>): ReadonlyArray<ZipEntry> => {
  const entries: ZipEntry[] = [];
  let snippetIndex = 0;
  for (const artifact of artifacts) {
    switch (artifact.kind) {
      case "file":
        entries.push(fileEntry(artifact.path, artifact.content));
        break;
      case "snippet": {
        snippetIndex += 1;
        const ext = artifact.lang === null ? "txt" : (SNIPPET_EXT[artifact.lang.toLowerCase()] ?? "txt");
        const num = String(snippetIndex).padStart(3, "0");
        entries.push({ path: `snippets/snippet-${num}.${ext}`, text: artifact.text });
        break;
      }
    }
  }
  return uniquify(entries);
};

// [LAW:effects-at-boundaries] Base64-encode the archive bytes for embedding in the page
// (the client decodes them back with atob). Written over Uint8Array with no `Buffer` or
// `btoa`, so it runs identically in the Cloudflare Workers render runtime and the Node
// test runtime [LAW:no-ambient-temporal-coupling on host globals].
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const bytesToBase64 = (bytes: Uint8Array): string => {
  // B64.charAt is total (a masked 0..63 index is always in range), so the alphabet
  // lookups need no assertion; the byte reads are in-bounds by each loop/remainder guard.
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64.charAt((n >>> 18) & 63) + B64.charAt((n >>> 12) & 63) + B64.charAt((n >>> 6) & 63) + B64.charAt(n & 63);
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64.charAt((n >>> 18) & 63) + B64.charAt((n >>> 12) & 63) + "==";
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64.charAt((n >>> 18) & 63) + B64.charAt((n >>> 12) & 63) + B64.charAt((n >>> 6) & 63) + "=";
  }
  return out;
};

// [LAW:dataflow-not-control-flow] The document-scoped code-export control, or NOTHING
// when there is no code — the absence is a value (empty string) the page renders as
// nothing, never a dead button. It carries two sibling affordances over the SAME
// artifacts: copy-all (a text payload) and download (a zip of the file tree).
// [LAW:one-type-per-behavior] Both are the same shape — a pill button beside a hidden
// sibling <pre> holding the server-built payload the button reads (the copy-code seam)
// — so they share the .code-export-pill class and each stays hidden until its own client
// capability check reveals it, so a no-JS or unsupported viewer never meets a button
// that cannot act [LAW:no-silent-failure].
export const renderCodeExportControl = (artifacts: ReadonlyArray<CodeArtifact>): string => {
  if (artifacts.length === 0) return "";
  // [LAW:one-source-of-truth] No separate aria-label on either button: the visible text
  // is each button's ONLY accessible name, so its "Copied"/"Downloaded" flip is the
  // confirmation SR users hear too — a redundant aria-label would freeze the announced
  // name and hide the count.
  const copyLabel = `Copy all code · ${plural(artifacts.length, "block")}`;
  const copyPayload = formatCodeArtifacts(artifacts);
  // The zip payload is built ONCE from one download tree, feeding both the file count in
  // the label and the embedded archive — one derivation, no drift.
  const tree = downloadTree(artifacts);
  const zipBase64 = bytesToBase64(zipArchive(tree));
  const downloadLabel = `Download as files · ${plural(tree.length, "file")}`;
  return (
    `<button type="button" class="mono-pill code-export-pill copy-all-code" data-copy-all-code>${escapeHtml(copyLabel)}</button>` +
    `<pre class="copy-all-code-payload" hidden aria-hidden="true">${escapeHtml(copyPayload)}</pre>` +
    // The archive is base64 (no HTML-special chars), so it embeds verbatim; the client
    // reads it from this sibling and decodes exactly these bytes [LAW:one-source-of-truth].
    `<button type="button" class="mono-pill code-export-pill download-all-code" data-download-all-code>${escapeHtml(downloadLabel)}</button>` +
    `<pre class="download-all-code-payload" hidden aria-hidden="true">${zipBase64}</pre>`
  );
};
