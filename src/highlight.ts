// [LAW:single-enforcer] / [LAW:no-shared-mutable-globals] highlight.js keeps a
// global language registry. This module is its single owner: the registration
// list below is the one place that decides *which languages we ship*, and
// highlightCode is the one entry point that turns code text into highlighted
// markup. render.ts's code() renderer calls it; nothing else touches hljs.
//
// [LAW:carrying-cost] We import from highlight.js/lib/core and register a curated
// subset rather than the full build, so the Worker (and the client editor bundle,
// which renders the same preview through renderMarkdown) ship only these grammars,
// not all ~190. Adding a language is one import + one register line here.

import hljs from "highlight.js/lib/core";

import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// Registration runs once at module load. hljs.registerLanguage also wires each
// grammar's aliases (js→javascript, ts→typescript, sh→bash, yml→yaml, html→xml…),
// so getLanguage() below resolves the names authors actually fence with.
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("php", php);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

// The subset hljs.highlightAuto considers when a fence omits its language.
// Deliberately narrow — two reasons, both serving accuracy:
//   1. plaintext/diff/markdown/xml would "match" prose and drown real detection.
//   2. Every extra candidate with an overlapping grammar (c/cpp/java all have
//      braces; ruby/php overlap many tokens) steals relevance from the true
//      language, shrinking the best-vs-secondBest MARGIN the confidence gate
//      relies on. So auto-detection considers only the distinctive languages that
//      actually appear UNLABELED in coding transcripts. A labeled fence in any
//      registered language above still highlights — this list only governs the
//      guess for a fence that named nothing. [LAW:no-silent-failure]
const AUTO_SUBSET = [
  "bash",
  "go",
  "javascript",
  "json",
  "python",
  "rust",
  "sql",
  "typescript",
  "yaml",
];

// Confidence gate for auto-detection. hljs.highlightAuto returns a `relevance`
// (how much language-specific structure it found — grows with block size) and a
// `secondBest` (the runner-up language). The two together separate real code from
// noise; neither alone does. Measured against real blocks:
//   - genuine code (5+ lines): relevance 6–12, margin (best − secondBest) 2–6
//   - mis-detections of tiny snippets and prose: relevance 1–4, margin 0–2
// The MARGIN is the primary signal (a confident classification beats its runner-up
// decisively), and the relevance FLOOR rejects the few prose samples that reach
// margin 2 on noise while still scoring low. We require BOTH and otherwise refuse
// to the safe `plain` state — a wrong auto-label that mangles the display is worse
// than no color. [LAW:no-silent-failure]
const AUTO_RELEVANCE_THRESHOLD = 5;
const AUTO_RELEVANCE_MARGIN = 2;

// [LAW:types-are-the-program] The three legal outcomes of asking "how should this
// code block render", and only those. `highlighted` carries hljs markup (already
// HTML-escaped by hljs, so it is trusted-by-construction) together with the
// language that produced it — there is no highlighted-without-a-language state.
// `labeled` is a declared language we don't ship a grammar for: honor the author's
// label, but the body stays plain (we never silently relabel their fence). `plain`
// is an unlabeled block we could not confidently classify: no label, no color.
export type Highlighted =
  | { readonly kind: "highlighted"; readonly html: string; readonly language: string }
  | { readonly kind: "labeled"; readonly language: string }
  | { readonly kind: "plain" };

// [LAW:effects-at-boundaries] Pure: code text in, a description of how to render
// out. No DOM, no IO — runs identically in the Worker and the browser editor
// bundle, and is exercised by the same node test harness as the other parsers.
export const highlightCode = (text: string, lang: string | undefined): Highlighted => {
  if (lang) {
    // An author-declared language is authoritative — we highlight as it even on a
    // low grammar match (ignoreIllegals) rather than second-guess the author.
    const canonical = hljs.getLanguage(lang) ? lang : null;
    if (canonical === null) return { kind: "labeled", language: lang };
    const { value } = hljs.highlight(text, { language: canonical, ignoreIllegals: true });
    return { kind: "highlighted", html: value, language: lang };
  }
  const auto = hljs.highlightAuto(text, AUTO_SUBSET);
  // An absent secondBest means nothing else in the subset matched — an
  // unambiguous classification, so it clears the margin by construction.
  const margin = auto.secondBest
    ? auto.relevance - auto.secondBest.relevance
    : Infinity;
  const detected = auto.language;
  if (
    detected &&
    auto.relevance >= AUTO_RELEVANCE_THRESHOLD &&
    margin >= AUTO_RELEVANCE_MARGIN
  ) {
    return { kind: "highlighted", html: auto.value, language: detected };
  }
  return { kind: "plain" };
};
