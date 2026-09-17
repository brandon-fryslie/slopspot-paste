// [LAW:decomposition] The digest service: each turn's readable text, summarized ahead of the
// reader through the Summarizer the page has, kept on the device. One sentence, no "and"
// hiding a second job — this module decides WHAT of a turn is summarized, under which key,
// in which order, and reports each turn's outcome. It creates no Summarizer (availability,
// consent and download are the turn card's, the page-level surface that owns user
// activation), renders nothing and speaks nothing: the turn card and Listen's narrator both
// read the same per-turn outcome from it.
//
// A PROJECTION, NEVER A SOURCE [LAW:one-source-of-truth]. A digest is a disposable derivation
// of the stored original, exactly as Listen's audio is: keyed by a hash of the readable text
// it was made from plus the identity of the summarizer that made it, kept on the device only,
// never sent to or stored on the server. An edited turn or a different model is a different
// key and simply misses; nothing is invalidated, because nothing can go stale under its own
// key [LAW:no-ambient-temporal-coupling].
//
// [LAW:one-way-deps] The service depends on the Summarizer API SURFACE (the three members
// below, as the Writing Assistance APIs spec states them) and never on which implementation
// answers — Chrome's native one today, the polyfill in Safari later. The Summarizer, the
// store and the hash are parameters [LAW:effects-at-boundaries], so scripts/turn-digest-check.ts
// drives every arm with a stub whose quota is small and a Map for the device.
//
// WHAT IS SUMMARIZED. A turn's input is its readable prose as the reader sees it on the spine
// — nodeVisibleTexts, the one authority dialogue.ts owns and the transcript projection reads
// — taken from the VIEWABLE node (deriveViewableDialogue), so a hidden turn carries its
// "[redacted]" marker and a redacted span its blank, never the original. Thinking, tool calls
// and the source's own turn-summary block are not on the spine and so are not input; that
// turn-summary is a different thing from a digest and is left where it is.
//
// [LAW:no-silent-failure] A turn's outcome is a value with a failed arm that carries the
// reason; a Summarizer that throws, a paragraph no split can fit under the quota, or digests
// that never pack down to one all land there, and the turn's text is unaffected. A short
// turn is its own digest and gets `none`, not a one-line paraphrase of itself.

import { contentHash } from "./contentHash";
import type { DisplayNode, ViewableDialogue } from "./dialogue";
import { nodeRole, nodeVisibleTexts } from "./dialogue";
import type { Fence } from "./fence";
import { closesFence, opensFence } from "./fence";
import type { PreferenceStore } from "./preferenceStore";
import type { Role } from "./types";

// ── the input ────────────────────────────────────────────────────────────────────────

// Below this many readable words a turn is its own digest. One named value; the turn card's
// checkpoint tunes it.
export const DIGEST_MIN_WORDS = 80;

// [LAW:types-are-the-program] The selection: who spoke, and the readable prose in its
// paragraphs — the grain the quota split cuts at, so a part never ends mid-sentence or
// mid-fence.
export interface DigestInput {
  readonly speaker: Role;
  readonly paragraphs: ReadonlyArray<string>;
}

// [LAW:dataflow-not-control-flow] Prose split at its blank lines, a fenced code block kept
// whole: the fence's own blank lines are inside it, and a fence that opens in one part and
// closes in another is no paragraph. Where a fence opens and closes is fence.ts's answer,
// the one the speech segmenter reads too. An unclosed fence runs to the end of its text, as
// there. Exported for the check; selectDigestInput is its caller.
export const paragraphsOf = (prose: string): ReadonlyArray<string> => {
  const paragraphs: string[] = [];
  let open: string[] = [];
  let fence: Fence | null = null;
  const close = (): void => {
    const text = open.join("\n").trim();
    if (text.length > 0) paragraphs.push(text);
    open = [];
  };
  for (const line of prose.split("\n")) {
    if (fence === null && line.trim() === "") {
      close();
      continue;
    }
    fence = fence === null ? opensFence(line) : closesFence(line, fence) ? null : fence;
    open.push(line);
  }
  close();
  return paragraphs;
};

// [LAW:effects-at-boundaries] Pure: the viewable node's spine texts, each in its paragraphs.
// A block is read on its own, as the speech segmenter reads it, so a block boundary is a
// paragraph boundary and a fence left open in one block never swallows the next.
export const selectDigestInput = (display: DisplayNode): DigestInput => ({
  speaker: nodeRole(display.node),
  paragraphs: nodeVisibleTexts(display.node).flatMap(paragraphsOf),
});

export const wordCount = (input: DigestInput): number =>
  input.paragraphs.reduce((words, paragraph) => words + paragraph.split(/\s+/).length, 0);

// ── the key ──────────────────────────────────────────────────────────────────────────

// [LAW:one-source-of-truth] What makes two digests of the same text different: the
// summarizer's options as the spec names them, and the implementation behind them — a name
// the page composes from what it knows (the polyfill knows its model; Chrome's native
// Summarizer names no model, so its identity is the browser's). A change to any of these
// is a new key; the old entry is merely unused.
export interface SummarizerIdentity {
  readonly type: string;
  readonly format: string;
  readonly length: string;
  readonly implementation: string;
}

// The device key of a turn's digest: the exact input the summarizer reads plus the identity
// of the one reading it, through the one content-hash move every projection cache keys with.
export const digestKey = (input: DigestInput, identity: SummarizerIdentity): Promise<string> =>
  contentHash({ input, identity });

// ── the seams ────────────────────────────────────────────────────────────────────────

// [LAW:one-way-deps] The Summarizer surface this service reads, as the Writing Assistance
// APIs spec states it: a quota in the implementation's own units, a measure of an input in
// those units under the same options a summarize call takes (the context counts toward the
// quota), and the summary of an input. Nothing of create(), availability() or the download is
// here — a Summarizer arrives already made.
export interface SummarizeOptions {
  readonly context?: string;
  readonly signal?: AbortSignal;
}
export interface Summarizer {
  readonly inputQuota: number;
  measureInputUsage(input: string, options?: SummarizeOptions): Promise<number>;
  summarize(input: string, options?: SummarizeOptions): Promise<string>;
}

// A digest as the device keeps it: the text, and whether it was combined from the digests
// of a turn too long for one summarize call.
export interface Digest {
  readonly text: string;
  readonly combined: boolean;
}

// [LAW:types-are-the-program] The device's digest store never rejects: a read the device
// refuses is undefined and a write it refuses is not kept — a refused store is the adapter's
// to answer (preferenceDigestStore below, over deviceStore), nowhere else [LAW:single-enforcer].
export interface DigestStore {
  get(key: string): Promise<Digest | undefined>;
  put(key: string, digest: Digest): Promise<void>;
}

const STORE_PREFIX = "digest.";
const KEPT_KEYS = "digest-kept";

// How many digests the device keeps, oldest out first: a digest is a few hundred bytes, so
// this is well under a megabyte of the storage the Listen preferences share, and an
// unbounded cache would one day fill that storage and take those preferences with it.
export const DIGEST_KEEP = 1_000;

// [LAW:parse-dont-validate] A kept entry is a Digest, or it is not this build's and reads as
// absent. The store is the page's preference store, so a refused device already reads as
// nothing kept and takes no write.
// [LAW:no-silent-failure] exception: a kept value that does not parse is a cache entry
// another build wrote, and absent is its true reading — the digest is re-derived, nothing
// is lost.
const parseDigest = (kept: string | null): Digest | undefined => {
  if (kept === null) return undefined;
  try {
    const value: unknown = JSON.parse(kept);
    return typeof value === "object" && value !== null && "text" in value && "combined" in value &&
      typeof value.text === "string" && typeof value.combined === "boolean"
      ? { text: value.text, combined: value.combined }
      : undefined;
  } catch {
    return undefined;
  }
};

// The kept keys in the order they were put, the eviction order; a value this build did not
// write reads as none kept.
// [LAW:no-silent-failure] exception: as parseDigest — a list that does not parse starts the
// list over; the entries it named stay on the device, readable but no longer evictable, the
// bounded cost of a list this build did not write.
const parseKeys = (kept: string | null): ReadonlyArray<string> => {
  if (kept === null) return [];
  try {
    const value: unknown = JSON.parse(kept);
    return Array.isArray(value) && value.every((key) => typeof key === "string") ? value : [];
  } catch {
    return [];
  }
};

// The kept list is written before the digest it names, and the digest only once the list is
// read back as written: a device that refuses the list's write (it is the larger of the two)
// keeps no entry the list cannot evict.
export const preferenceDigestStore = (store: PreferenceStore, keep: number = DIGEST_KEEP): DigestStore => ({
  get: async (key) => parseDigest(store.getItem(STORE_PREFIX + key)),
  put: async (key, digest) => {
    const keys = [...parseKeys(store.getItem(KEPT_KEYS)).filter((kept) => kept !== key), key];
    const evicted = keys.slice(0, Math.max(0, keys.length - keep));
    for (const old of evicted) store.removeItem(STORE_PREFIX + old);
    const list = JSON.stringify(keys.slice(evicted.length));
    store.setItem(KEPT_KEYS, list);
    if (store.getItem(KEPT_KEYS) === list) store.setItem(STORE_PREFIX + key, JSON.stringify(digest));
  },
});

// ── one turn's digest ────────────────────────────────────────────────────────────────

// The context each summarize call is given: whose words these are. Not part of the key,
// as the TL;DR's system prompt is not part of its key — a rewording re-derives future
// digests and is never coupled to the ones already kept [LAW:no-ambient-temporal-coupling].
const SPEAKER_WORD: { readonly [R in Role]: string } = {
  user: "the user's message",
  system: "a system message",
  assistant: "the assistant's reply",
};
const turnContext = (speaker: Role): string =>
  `This is ${SPEAKER_WORD[speaker]} in a transcript of a conversation with an AI assistant.`;
const COMBINED_CONTEXT = "These are digests of consecutive parts of one long turn in a transcript of a conversation with an AI assistant; digest them as one.";

const joinParagraphs = (paragraphs: ReadonlyArray<string>): string => paragraphs.join("\n\n");

// [LAW:dataflow-not-control-flow] Paragraphs packed into parts that each measure under the
// quota, measured under the context they will be summarized with. The whole measured first:
// a turn that fits is one part for one call, the common case. Otherwise greedy: a paragraph
// joins the open part while the part still fits, else closes it and opens the next.
// Exported for the check; the service is its one caller, packing paragraphs in the first
// round and part digests after, which is what `noun` names in the reason.
// [LAW:no-silent-failure] A paragraph that measures over the quota on its own fits no part;
// thrown, and the service reports it as the turn's failure.
export const packByQuota = async (
  paragraphs: ReadonlyArray<string>,
  summarizer: Pick<Summarizer, "inputQuota" | "measureInputUsage">,
  options: SummarizeOptions,
  noun = "paragraph",
): Promise<ReadonlyArray<string>> => {
  const usageOf = async (part: ReadonlyArray<string>): Promise<number> =>
    summarizer.measureInputUsage(joinParagraphs(part), options);
  const over = (usage: number): Error =>
    new Error(`a ${noun} measures ${usage} against the summarizer's quota of ${summarizer.inputQuota}`);
  if ((await usageOf(paragraphs)) <= summarizer.inputQuota) return [joinParagraphs(paragraphs)];
  const parts: string[][] = [];
  let open: string[] = [];
  for (const paragraph of paragraphs) {
    const usage = await usageOf([...open, paragraph]);
    if (usage <= summarizer.inputQuota) {
      open.push(paragraph);
      continue;
    }
    if (open.length === 0) throw over(usage);
    const alone = await usageOf([paragraph]);
    if (alone > summarizer.inputQuota) throw over(alone);
    parts.push(open);
    open = [paragraph];
  }
  parts.push(open);
  return parts.map(joinParagraphs);
};

// One turn's digest: its paragraphs packed and each part summarized; while more than one
// digest remains, the digests are packed and summarized the same way, until one is left,
// marked combined. A combine round that packs no two digests together would be repeated
// without end, so it is the turn's failure with that reason [LAW:no-silent-failure]; so is
// a summarizer that answers nothing, since a blank kept under the turn's key would be served
// as its digest on every visit.
const digestOf = async (input: DigestInput, summarizer: Summarizer, signal: AbortSignal): Promise<Digest> => {
  const round = async (texts: ReadonlyArray<string>, context: string, noun: string): Promise<ReadonlyArray<string>> => {
    const parts = await packByQuota(texts, summarizer, { context, signal }, noun);
    if (noun !== "paragraph" && parts.length === texts.length) {
      throw new Error(`no two of the ${texts.length} part digests fit the summarizer's quota of ${summarizer.inputQuota} together: they cannot be combined`);
    }
    const digests: string[] = [];
    for (const part of parts) {
      const digest = await summarizer.summarize(part, { context, signal });
      if (digest.trim() === "") throw new Error(`the summarizer answered nothing for a ${noun === "paragraph" ? "part" : "round"} of the turn`);
      digests.push(digest);
    }
    return digests;
  };
  let digests = await round(input.paragraphs, turnContext(input.speaker), "paragraph");
  const combined = digests.length > 1;
  while (digests.length > 1) digests = await round(digests, COMBINED_CONTEXT, "part digest");
  const [text] = digests;
  if (text === undefined) throw new Error("the turn has no readable text to digest");
  return { text, combined };
};

// ── the service ──────────────────────────────────────────────────────────────────────

// [LAW:types-are-the-program] A turn's outcome, total: no digest because the turn is short;
// pending, not yet derived; ready, with the digest; failed, with the reason.
export type DigestOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "pending" }
  | ({ readonly kind: "ready" } & Digest)
  | { readonly kind: "failed"; readonly reason: string };

export type DigestListener = (index: number, outcome: DigestOutcome) => void;

export interface DigestService {
  // The outcome of the turn at this spine index (DisplayNode.index). A turn the dialogue
  // does not show is a caller's bug, thrown.
  outcome(index: number): DigestOutcome;
  subscribe(listener: DigestListener): () => void;
  // Derive every pending digest in reading order from the turn at this spine index to the
  // end, then from the start up to it; one at a time. A start while a walk is under way
  // re-aims it — the derivation in flight completes and the walk goes on from the new turn
  // — so a reader who keeps moving wastes no model work; the service is the one owner of
  // the live walk [LAW:no-ambient-temporal-coupling]. Resolves when the walk ends or is
  // stopped; rejects only with a listener's own throw.
  start(from: number): Promise<void>;
  // Abandon the derivation under way, as when the page leaves: nothing settles after this.
  stop(): void;
}

export interface DigestServiceConfig {
  readonly dialogue: ViewableDialogue;
  readonly summarizer: Summarizer;
  readonly identity: SummarizerIdentity;
  readonly store: DigestStore;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// One shown turn as the service holds it: its name to callers, its input, its outcome so far
// — the one place an outcome is written — and the derivation a walk has in flight on it, so
// a walk that comes after a stop waits for it rather than asking the summarizer twice.
interface Entry {
  readonly index: number;
  readonly input: DigestInput;
  outcome: DigestOutcome;
  inflight: Promise<DigestOutcome> | null;
}

// The walk under way: what stops it, and the promise a start answers with.
interface Walk {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

export const createDigestService = ({ dialogue, summarizer, identity, store }: DigestServiceConfig): DigestService => {
  const entries: ReadonlyArray<Entry> = dialogue.map((display) => {
    const input = selectDigestInput(display);
    return { index: display.index, input, outcome: wordCount(input) < DIGEST_MIN_WORDS ? { kind: "none" } : { kind: "pending" }, inflight: null };
  });
  const byIndex = new Map(entries.map((entry) => [entry.index, entry]));
  const listeners = new Set<DigestListener>();
  let from = 0;
  let live: Walk | null = null;

  // The outcome is written before any listener hears it, and every listener hears it, so a
  // listener that throws leaves the outcome right and the others told. What the listeners
  // threw is returned, not thrown: the walk goes on to the next turn and reports them all at
  // its end to the caller of start, whose listeners they are.
  const settle = (entry: Entry, outcome: DigestOutcome): ReadonlyArray<unknown> => {
    entry.outcome = outcome;
    const thrown: unknown[] = [];
    for (const listener of listeners) {
      try {
        listener(entry.index, outcome);
      } catch (error) {
        thrown.push(error);
      }
    }
    return thrown;
  };

  // The next pending turn in reading order: the first shown turn at or after `from`, to the
  // end, then the rest from the start. A `from` past every shown turn reads from the start.
  const next = (): Entry | undefined => {
    const at = Math.max(0, entries.findIndex((entry) => entry.index >= from));
    return [...entries.slice(at), ...entries.slice(0, at)].find((entry) => entry.outcome.kind === "pending");
  };

  // A kept digest, or a fresh one that is then kept; the signal is read after every await so
  // a stopped walk asks the summarizer nothing more.
  const derive = async (entry: Entry, signal: AbortSignal): Promise<Digest> => {
    const key = await digestKey(entry.input, identity);
    signal.throwIfAborted();
    const kept = await store.get(key);
    signal.throwIfAborted();
    if (kept !== undefined) return kept;
    const digest = await digestOf(entry.input, summarizer, signal);
    signal.throwIfAborted();
    await store.put(key, digest);
    return digest;
  };

  // [LAW:no-silent-failure] Whatever the derivation throws is the turn's failure, reason
  // kept — a Summarizer's own abort included, since the walk's signal is the one thing that
  // says this walk was stopped.
  const outcomeOf = async (entry: Entry, signal: AbortSignal): Promise<DigestOutcome> => {
    try {
      return { kind: "ready", ...(await derive(entry, signal)) };
    } catch (error) {
      return { kind: "failed", reason: reasonOf(error) };
    }
  };

  // The walk clears itself as the live one in its own finally, before its promise settles,
  // so a start from a listener opens a new walk rather than answering with one that is
  // ending. A turn a stopped walk still has in flight is waited for, never derived beside.
  const walk = async (controller: AbortController): Promise<void> => {
    const { signal } = controller;
    const thrown: unknown[] = [];
    try {
      for (let entry = next(); entry !== undefined; entry = next()) {
        await entry.inflight?.catch(() => undefined);
        if (signal.aborted) return;
        const derivation = outcomeOf(entry, signal);
        entry.inflight = derivation;
        const outcome = await derivation;
        if (entry.inflight === derivation) entry.inflight = null;
        if (signal.aborted) return;
        thrown.push(...settle(entry, outcome));
      }
    } finally {
      if (live?.controller === controller) live = null;
    }
    if (thrown.length > 0) throw new AggregateError(thrown, `${thrown.length} digest listener throw${thrown.length === 1 ? "" : "s"}`);
  };

  const stop = (): void => {
    live?.controller.abort();
    live = null;
  };

  // The walk begins on a microtask, after `live` names it, so a walk with nothing to do
  // clears `live` rather than finishing before it was ever set.
  const start = (at: number): Promise<void> => {
    from = at;
    if (live !== null) return live.done;
    const controller = new AbortController();
    live = { controller, done: Promise.resolve().then(() => walk(controller)) };
    return live.done;
  };

  return {
    outcome: (index) => {
      const entry = byIndex.get(index);
      if (entry === undefined) throw new RangeError(`turn ${index} is not among the dialogue's ${entries.length} shown turns`);
      return entry.outcome;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start,
    stop,
  };
};
