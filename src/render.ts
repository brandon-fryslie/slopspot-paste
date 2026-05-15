import { Marked } from "marked";

// [LAW:one-source-of-truth] Source markdown stays in storage. HTML is derived
// per request. Since pastes are write-once, the derived form cannot go stale.
// [LAW:single-enforcer] All markdown→HTML rendering goes through renderMarkdown.
// Callsites never touch marked directly.

const escapeHtml = (s: string): string =>
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
