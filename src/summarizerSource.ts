// [LAW:decomposition] The browser's Summarizer as this page asks for it: what it can do,
// and one made ready to use. One sentence, no "and" hiding a second job — this module
// knows nothing of turns, digests, caches or consent; it answers "can this browser
// summarize?" and "give me the summarizer" and stops there. The digest service
// (turnDigest.ts) takes what this makes and never asks for it, so the service is the same
// service under the polyfill that will answer here in Safari [LAW:one-way-deps].
//
// [LAW:effects-at-boundaries] The global is a PARAMETER, not a reach for `self.Summarizer`
// inside the functions: scripts/summarizer-source-check.ts drives a browser that has no
// Summarizer, one whose model is downloadable, one already downloading and one that
// refuses, none of which exist in Node and only one of which exists in any given Chrome.
//
// SPEC: Writing Assistance APIs, W3C CG draft (10 Aug 2026),
// https://webmachinelearning.github.io/writing-assistance-apis/ . Chrome ships it from 138,
// on Window only. Everything below is that spec's own vocabulary; nothing here is invented.

import type { Summarizer as DigestSummarizer, SummarizerIdentity } from "./turnDigest";

// [LAW:types-are-the-program] The options that make one summarizer different from another,
// exactly the three the spec names and the three the digest key carries. Not the whole
// create() dictionary: the fields this app never sets (sharedContext, the language hints)
// would be a difference the key cannot see, so they are not settable here at all.
export interface SummarizerOptions {
  readonly type: string;
  readonly format: string;
  readonly length: string;
}

// The digest's own options, named once. `tldr` because a turn's digest answers "what is in
// this turn" in a breath, not a list of its points; `plain-text` because the digest is
// written to the page as text and never as markup, so there is no sanitizing step to get
// wrong [LAW:polishing-by-subtraction]; `short` because it sits at the head of the turn it
// summarizes and a reader who wanted the long version has it directly below.
export const DIGEST_OPTIONS: SummarizerOptions = { type: "tldr", format: "plain-text", length: "short" };

// What the browser answers about a summarizer with those options, as the spec states it.
const AVAILABILITIES = ["unavailable", "downloadable", "downloading", "available"] as const;
export type SummarizerAvailability = (typeof AVAILABILITIES)[number];

// [LAW:parse-dont-validate] The browser's answer is a string this build may not know — a
// later spec revision may name a fifth state. An unrecognised answer is "unavailable": the
// one reading that shows the reader no affordance they cannot use, and the only safe guess
// about a state whose meaning this build does not hold [LAW:no-silent-failure].
export const parseAvailability = (answer: unknown): SummarizerAvailability =>
  AVAILABILITIES.find((known) => known === answer) ?? "unavailable";

// A summarizer this page holds: the three members the digest service reads, plus the
// release the spec gives for letting the model go when the page is done with it.
export interface HeldSummarizer extends DigestSummarizer {
  destroy(): void;
}

// [LAW:types-are-the-program] Exactly the surface of the global this module touches, so the
// real `Summarizer` satisfies it structurally and the check's stub implements no more. The
// monitor is the spec's: create() calls it synchronously with an EventTarget that fires
// `downloadprogress` (a ProgressEvent whose `loaded` runs 0..1 against a `total` of 1).
export interface SummarizerSource {
  availability(options: SummarizerOptions): Promise<unknown>;
  create(options: SummarizerOptions & {
    monitor?: (monitor: EventTarget) => void;
    signal?: AbortSignal;
  }): Promise<HeldSummarizer>;
}

// [LAW:parse-dont-validate] The global, or nothing: a browser without the API, and one
// whose `Summarizer` is some other page's global of the same name, both read as no source
// rather than as a source that throws on first use. The scope is a parameter because the
// page has `self` and the check has neither.
export const summarizerSource = (scope: unknown): SummarizerSource | null => {
  if (typeof scope !== "object" || scope === null || !("Summarizer" in scope)) return null;
  const candidate: unknown = (scope as { Summarizer: unknown }).Summarizer;
  if (typeof candidate !== "object" && typeof candidate !== "function") return null;
  if (candidate === null) return null;
  const held = candidate as Partial<SummarizerSource>;
  return typeof held.availability === "function" && typeof held.create === "function"
    ? (candidate as SummarizerSource)
    : null;
};

// Chrome's native Summarizer names no model and offers no version, so the identity of the
// thing that wrote a digest is, truthfully, "the browser's own". A model the browser
// updates under this name serves the digests it already wrote, which is right for a
// projection of unchanged text: the alternative — keying on the user-agent string — throws
// every digest on the device away on each browser update and buys nothing a reader can see
// [LAW:no-ambient-temporal-coupling].
export const NATIVE_IMPLEMENTATION = "native";

export const summarizerIdentity = (options: SummarizerOptions, implementation: string): SummarizerIdentity => ({
  type: options.type,
  format: options.format,
  length: options.length,
  implementation,
});

export const availabilityOf = async (source: SummarizerSource, options: SummarizerOptions): Promise<SummarizerAvailability> =>
  parseAvailability(await source.availability(options));

// [LAW:dataflow-not-control-flow] The download's progress is a value handed on as the
// browser reports it — the spec's 0..1 `loaded` — not a percentage this module formats or a
// state it remembers. A create that needs no download simply never calls it.
//
// [LAW:no-silent-failure] A create the browser refuses — no user activation for a download
// it needs, a model it cannot fetch, the reader's own abort — rejects, and the panel says
// so. It is never answered with a summarizer that summarizes nothing.
export const openSummarizer = (
  source: SummarizerSource,
  options: SummarizerOptions,
  onProgress: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<HeldSummarizer> =>
  source.create({
    ...options,
    signal,
    monitor: (monitor) => {
      monitor.addEventListener("downloadprogress", (event) => {
        const { loaded } = event as ProgressEvent;
        onProgress(loaded);
      });
    },
  });
