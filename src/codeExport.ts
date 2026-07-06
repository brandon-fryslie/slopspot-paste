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
import { escapeHtml } from "./render";

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

// [LAW:dataflow-not-control-flow] The document-scoped control, or NOTHING when there is
// no code to copy — the absence is a value (empty string) the page renders as nothing,
// never a dead button. [LAW:one-source-of-truth] the button carries no copy of the data:
// the payload lives once in a hidden sibling <pre> (escaped here, decoded back verbatim
// by the client's textContent read), exactly as .copy-code reads its sibling <code>. It
// stays hidden until the page's client confirms clipboard support and wires it
// (body.copy-all-ready), mirroring .copy-code so a no-JS viewer never meets a button that
// cannot act [LAW:no-silent-failure].
export const renderCodeExportControl = (artifacts: ReadonlyArray<CodeArtifact>): string => {
  if (artifacts.length === 0) return "";
  const n = artifacts.length;
  const label = `Copy all code · ${n} block${n === 1 ? "" : "s"}`;
  const payload = formatCodeArtifacts(artifacts);
  return (
    // [LAW:one-source-of-truth] No separate aria-label: the visible text is the button's
    // ONLY accessible name. A redundant aria-label would override the text for screen
    // readers — hiding the block count and freezing the announced name at "Copy all code"
    // while the text flips to "Copied". With the text as the sole name, that flip is the
    // confirmation SR users hear too.
    `<button type="button" class="copy-all-code" data-copy-all-code>${escapeHtml(label)}</button>` +
    `<pre class="copy-all-code-payload" hidden aria-hidden="true">${escapeHtml(payload)}</pre>`
  );
};
