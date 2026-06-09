import { Marked } from "marked";

// [LAW:one-source-of-truth] Source markdown stays in storage. HTML is derived
// per request. Since pastes are write-once, the derived form cannot go stale.
// [LAW:single-enforcer] All markdown→HTML rendering goes through renderMarkdown.
// Callsites never touch marked directly.

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// [LAW:single-enforcer] Attribute-context escaping lives beside escapeHtml so
// there is one home for "make this string safe to interpolate." The extra
// quote escaping is what an attribute value needs that element text does not.
export const escapeAttr = (s: string): string =>
  escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// ─── URL safety ──────────────────────────────────────────────────────
// [LAW:single-enforcer] renderMarkdown is the one boundary where pasted text
// becomes markup, so the theorem "no byte of input becomes executable HTML"
// is kept here and nowhere else. Pasted links carry one of the two XSS vectors
// (the other is raw HTML, handled in the renderer below): a `javascript:` href
// runs on click.
//
// [LAW:types-are-the-program] A href is safe to emit iff — after stripping the
// control/space characters a browser ignores while resolving a scheme — it is
// either scheme-relative/path-relative (no scheme to abuse) or carries an
// allowlisted scheme. Default-deny: an unknown scheme is the unsafe case, so we
// never enumerate the dangerous ones. A blocklist leaks (miss one and it runs);
// an allowlist cannot.
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const SAFE_SCHEME_RE = /^(https?|mailto|tel):/i;

export const sanitizeUrl = (href: string): string => {
  // Browsers ignore C0 controls, space, and NBSP when reading a scheme, so a
  // `java\nscript:` payload resolves live. Strip them before the scheme test.
  const normalized = href.replace(/[\u0000-\u0020\u00a0]/g, "");
  if (!URL_SCHEME_RE.test(normalized)) return href;
  if (SAFE_SCHEME_RE.test(normalized)) return href;
  return "#";
};

// ─── Table normalization ─────────────────────────────────────────────
// LLMs commonly emit pipe-separated rows without the GFM separator row,
// e.g. `| a | b |` followed by `| 1 | 2 |` with no `| --- | --- |` in
// between. Marked's table type-guard requires the separator, so without it
// the block is rendered as paragraphs of pipe-laden text — unaligned and
// blowing past the column. We detect the recoverable shape and inject the
// separator so marked's normal table path runs unchanged.
//
// [LAW:types-are-the-program] A "table block" is N>=2 consecutive non-empty
// lines, each with the same number of pipe-separated cells (>=2). Validity
// upgrade — adding the separator — is purely structural; no per-callsite
// branching downstream.
// [LAW:dataflow-not-control-flow] Same renderMarkdown path for every message.
// We rewrite the *input* into the canonical GFM shape; we don't fork the
// renderer based on what kind of table we saw.

const FENCE_RE = /^\s*(```|~~~)/;

// A GFM separator row: pipes around 2+ cells, each `:?-+:?`, optional spaces.
const SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

// Pipes are unescaped `|` (not `\|`). Count cells by splitting on unescaped
// pipes after stripping the optional leading/trailing pipe.
const splitPipes = (line: string): string[] => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  // Split on `|` that isn't preceded by a backslash.
  return inner.split(/(?<!\\)\|/);
};

const cellCount = (line: string): number => {
  if (!line.includes("|")) return 0;
  return splitPipes(line).length;
};

const normalizePipeRow = (line: string): string => {
  let t = line.trim();
  if (!t.startsWith("|")) t = "| " + t;
  if (!t.endsWith("|")) t = t + " |";
  return t;
};

const synthesizeSeparator = (cells: number): string =>
  "| " + Array(cells).fill("---").join(" | ") + " |";

export const normalizeTables = (md: string): string => {
  const lines = md.split("\n");
  const out: string[] = [];
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (inFence) {
      out.push(line);
      i++;
      continue;
    }
    const firstCount = cellCount(line);
    if (firstCount >= 2) {
      // Collect the contiguous pipe-line run.
      const run: string[] = [];
      let j = i;
      while (j < lines.length) {
        const c = cellCount(lines[j]!);
        if (c < 2) break;
        run.push(lines[j]!);
        j++;
      }
      // Need at least 2 rows AND all rows must agree on cell count.
      // Mismatched counts → likely prose with pipes; leave untouched.
      const counts = run.map(cellCount);
      const allMatch = counts.length >= 2 && counts.every((c) => c === counts[0]);
      if (allMatch) {
        const cells = counts[0]!;
        const hasSep = run.length >= 2 && SEPARATOR_RE.test(run[1]!);
        if (hasSep) {
          // Already valid GFM; normalize pipes for consistency.
          for (const r of run) out.push(normalizePipeRow(r));
        } else {
          out.push(normalizePipeRow(run[0]!));
          out.push(synthesizeSeparator(cells));
          for (let k = 1; k < run.length; k++) out.push(normalizePipeRow(run[k]!));
        }
        i = j;
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
};

export const renderMarkdown = (md: string): string => {
  const normalized = normalizeTables(md);
  const m = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      code({ text, lang }) {
        const langClass = lang ? ` language-${escapeAttr(lang)}` : "";
        const langLabel = lang
          ? `<span class="code-lang" aria-hidden="true">${escapeHtml(lang)}</span>`
          : "";
        return `<pre class="code-block${langClass}">${langLabel}<code>${escapeHtml(text)}</code></pre>`;
      },
      codespan({ text }) {
        return `<code class="inline-code">${escapeHtml(text)}</code>`;
      },
      // [LAW:single-enforcer] Raw HTML is not a markup capability of this
      // renderer — it renders as the literal text it is, the same escaping move
      // code/codespan make for their content. This closes the stored-XSS vector
      // where a pasted <script> / <img onerror=...> would otherwise execute for
      // every viewer of the permalink.
      html({ text }) {
        return escapeHtml(text);
      },
    },
    // [LAW:dataflow-not-control-flow] Link/image safety is a property of the
    // href *value*, not a fork of the renderer: we rewrite a disallowed scheme
    // to an inert href on the token and let marked's default link/image
    // rendering run unchanged. The token's discriminant selects which tokens
    // carry a href to sanitize.
    walkTokens(token) {
      if (token.type === "link" || token.type === "image") {
        token.href = sanitizeUrl(token.href);
      }
    },
    hooks: {
      // Wrap every emitted table in a scroll container so a wide table
      // overflows *inside* the bubble rather than pushing the page.
      // [LAW:single-enforcer] One place owns the wrap; no per-template div.
      postprocess(html: string): string {
        return html
          .replace(/<table>/g, '<div class="table-wrap"><table>')
          .replace(/<\/table>/g, "</table></div>");
      },
    },
  });

  return m.parse(normalized, { async: false, gfm: true, breaks: false });
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
