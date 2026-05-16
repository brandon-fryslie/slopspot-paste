import { Marked } from "marked";

// [LAW:one-source-of-truth] Source markdown stays in storage. HTML is derived
// per request. Since pastes are write-once, the derived form cannot go stale.
// [LAW:single-enforcer] All markdown→HTML rendering goes through renderMarkdown.
// Callsites never touch marked directly.

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const renderMarkdown = (md: string): string => {
  const m = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      code({ text, lang }) {
        const langClass = lang ? ` language-${escapeHtml(lang)}` : "";
        const langLabel = lang
          ? `<span class="code-lang" aria-hidden="true">${escapeHtml(lang)}</span>`
          : "";
        return `<pre class="code-block${langClass}">${langLabel}<code>${escapeHtml(text)}</code></pre>`;
      },
      codespan({ text }) {
        return `<code class="inline-code">${escapeHtml(text)}</code>`;
      },
    },
  });

  return m.parse(md, { async: false, gfm: true, breaks: false });
};

// ─── Tool-output sub-parsers ─────────────────────────────────────────
// These take raw text from a ToolOutput and produce structured rows for
// per-kind rendering. They are pure functions — no DOM, no astro — so they
// can be unit-tested via the same node script as the conversation parser.

// [LAW:types-are-the-program] A diff is a list of typed line entries. The
// classifier is the line's leading shape: `<gutter><line-no> <marker><text>`
// for the first line of an added/removed/context entry, or `<gutter><marker><text>`
// for the continuation of a wrapped line.

export type DiffLineKind =
  | "context"
  | "added"
  | "removed"
  | "cont-context"
  | "cont-added"
  | "cont-removed"
  | "raw";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly lineNo: number | null;
  readonly content: string;
}

export interface DiffParsed {
  readonly summary: string | null;
  readonly lines: ReadonlyArray<DiffLine>;
}

const SUMMARY_RE = /^(Added|Removed|Updated|Changed|Wrote|Created)\b.*$/u;
const DIFF_FIRST_LINE_RE = /^\s*(\d+)\s([+\- ])\s?(.*)$/u;
const DIFF_CONT_LINE_RE = /^\s+([+\- ])(.*)$/u;

const markerToKind = (
  marker: string,
  isContinuation: boolean,
): DiffLineKind => {
  if (marker === "+") return isContinuation ? "cont-added" : "added";
  if (marker === "-") return isContinuation ? "cont-removed" : "removed";
  return isContinuation ? "cont-context" : "context";
};

export const parseDiff = (text: string): DiffParsed => {
  const raw = text.split("\n");
  let summary: string | null = null;
  const lines: DiffLine[] = [];
  let i = 0;
  while (i < raw.length && raw[i]!.trim() === "") i++;
  if (i < raw.length && SUMMARY_RE.test(raw[i]!.trim())) {
    summary = raw[i]!.trim();
    i++;
  }
  for (; i < raw.length; i++) {
    const line = raw[i]!;
    if (line.trim() === "") {
      lines.push({ kind: "raw", lineNo: null, content: "" });
      continue;
    }
    const m = DIFF_FIRST_LINE_RE.exec(line);
    if (m) {
      lines.push({
        kind: markerToKind(m[2]!, false),
        lineNo: parseInt(m[1]!, 10),
        content: m[3] ?? "",
      });
      continue;
    }
    const c = DIFF_CONT_LINE_RE.exec(line);
    if (c) {
      lines.push({
        kind: markerToKind(c[1]!, true),
        lineNo: null,
        content: c[2] ?? "",
      });
      continue;
    }
    lines.push({ kind: "raw", lineNo: null, content: line.trim() });
  }
  return { summary, lines };
};

// File-read output: `<gutter><line-no><space>...<space><content>`. The line
// number is right-aligned in a few characters of padding, followed by 1-2
// spaces, then the content verbatim.

export interface FileLine {
  readonly lineNo: number | null;
  readonly content: string;
}

export interface FileParsed {
  readonly summary: string | null;
  readonly lines: ReadonlyArray<FileLine>;
}

// Separator between line number and content is exactly 2 spaces or a tab.
// Wider regex would eat the file's own leading indentation.
const FILE_LINE_RE = /^\s*(\d+)(?:\t| {2})(.*)$/u;
const FILE_LINE_EMPTY_RE = /^\s*(\d+)\s*$/u;
const FILE_SUMMARY_RE = /^(Read|Loaded)\s+\d+\s+lines?/u;

export const parseFileRead = (text: string): FileParsed => {
  const raw = text.split("\n");
  let summary: string | null = null;
  let i = 0;
  while (i < raw.length && raw[i]!.trim() === "") i++;
  if (i < raw.length && FILE_SUMMARY_RE.test(raw[i]!.trim())) {
    summary = raw[i]!.trim();
    i++;
  }
  const lines: FileLine[] = [];
  for (; i < raw.length; i++) {
    const line = raw[i]!;
    const m = FILE_LINE_RE.exec(line);
    if (m) {
      lines.push({ lineNo: parseInt(m[1]!, 10), content: m[2] ?? "" });
      continue;
    }
    const e = FILE_LINE_EMPTY_RE.exec(line);
    if (e) {
      lines.push({ lineNo: parseInt(e[1]!, 10), content: "" });
      continue;
    }
    lines.push({ lineNo: null, content: line });
  }
  return { summary, lines };
};

// Bash terminal: combine the command and its output into one block, with the
// command `$`-prefixed and multi-line commands continuation-indented.
// [LAW:single-enforcer] The "what a terminal session looks like" formatting
// lives here, not split across CSS / template / parser.

export const formatBashTerminal = (command: string, output: string): string => {
  const trimmed = command.trim();
  const cmdLines = trimmed.length === 0 ? [] : trimmed.split("\n");
  const formattedCmd =
    cmdLines.length === 0
      ? ""
      : cmdLines
          .map((l, idx) => (idx === 0 ? `$ ${l}` : `  ${l.replace(/^\s+/, "")}`))
          .join("\n");
  if (output.length === 0) return formattedCmd;
  if (formattedCmd.length === 0) return output;
  return `${formattedCmd}\n${output}`;
};
