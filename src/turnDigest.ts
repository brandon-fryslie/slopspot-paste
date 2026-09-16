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
// — nodeVisibleProse, the one authority dialogue.ts owns and the transcript projection reads
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
import { nodeVisibleProse } from "./dialogue";
import type { PreferenceStore } from "./preferenceStore";

// ── the input ────────────────────────────────────────────────────────────────────────

// Below this many readable words a turn is its own digest. One named value; the turn card's
// checkpoint tunes it.
export const DIGEST_MIN_WORDS = 80;

// [LAW:types-are-the-program] The selection: who spoke, and the readable prose in its
// paragraphs — the grain the quota split cuts at, so a part never ends mid-sentence or
// mid-fence.
export type Speaker = "user" | "system" | "assistant";
export interface DigestInput {
  readonly speaker: Speaker;
  readonly paragraphs: ReadonlyArray<string>;
}

const FENCE = /^\s*(`{3,}|~{3,})/;

// [LAW:dataflow-not-control-flow] Prose split at its blank lines, a fenced code block kept
// whole: the fence's own blank lines are inside it, and a fence that opens in one part and
// closes in another is no paragraph. Exported for the check; selectDigestInput is its caller.
export const paragraphsOf = (prose: string): ReadonlyArray<string> => {
  const paragraphs: string[] = [];
  let open: string[] = [];
  let fence: string | null = null;
  const close = (): void => {
    const text = open.join("\n").trim();
    if (text.length > 0) paragraphs.push(text);
    open = [];
  };
  for (const line of prose.split("\n")) {
    const mark = FENCE.exec(line)?.[1]?.[0];
    if (fence === null && mark !== undefined) fence = mark;
    else if (mark === fence) fence = null;
    if (fence === null && line.trim() === "") close();
    else open.push(line);
  }
  close();
  return paragraphs;
};

// [LAW:effects-at-boundaries] Pure: the viewable node's spine prose in its paragraphs.
// nodeVisibleProse joins an assistant turn's spine blocks with a blank line, so a block
// boundary is a paragraph boundary here by construction.
export const selectDigestInput = (display: DisplayNode): DigestInput => ({
  speaker: display.node.kind === "spoken" ? display.node.role : "assistant",
  paragraphs: paragraphsOf(nodeVisibleProse(display.node)),
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

export type Hash = typeof contentHash;

// The device key of a turn's digest: the exact input the summarizer reads plus the identity
// of the one reading it, through the one content-hash move every projection cache keys with.
export const digestKey = (input: DigestInput, identity: SummarizerIdentity, hash: Hash = contentHash): Promise<string> =>
  hash({ input, identity });

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
const parseKeys = (kept: string | null): ReadonlyArray<string> => {
  if (kept === null) return [];
  try {
    const value: unknown = JSON.parse(kept);
    return Array.isArray(value) && value.every((key) => typeof key === "string") ? value : [];
  } catch {
    return [];
  }
};

export const preferenceDigestStore = (store: PreferenceStore, keep: number = DIGEST_KEEP): DigestStore => ({
  get: async (key) => parseDigest(store.getItem(STORE_PREFIX + key)),
  put: async (key, digest) => {
    const keys = [...parseKeys(store.getItem(KEPT_KEYS)).filter((kept) => kept !== key), key];
    const evicted = keys.slice(0, Math.max(0, keys.length - keep));
    for (const old of evicted) store.removeItem(STORE_PREFIX + old);
    store.setItem(STORE_PREFIX + key, JSON.stringify(digest));
    store.setItem(KEPT_KEYS, JSON.stringify(keys.slice(evicted.length)));
  },
});

// ── one turn's digest ────────────────────────────────────────────────────────────────

// The context each summarize call is given: whose words these are. Not part of the key,
// as the TL;DR's system prompt is not part of its key — a rewording re-derives future
// digests and is never coupled to the ones already kept [LAW:no-ambient-temporal-coupling].
const SPEAKER_WORD: { readonly [S in Speaker]: string } = {
  user: "the user's message",
  system: "a system message",
  assistant: "the assistant's reply",
};
const turnContext = (speaker: Speaker): string =>
  `This is ${SPEAKER_WORD[speaker]} in a transcript of a conversation with an AI assistant.`;
const COMBINED_CONTEXT = "These are digests of consecutive parts of one long turn in a transcript of a conversation with an AI assistant; digest them as one.";

const joinParagraphs = (paragraphs: ReadonlyArray<string>): string => paragraphs.join("\n\n");

// [LAW:dataflow-not-control-flow] Paragraphs packed into parts that each measure under the
// quota, measured under the context they will be summarized with. The whole measured first:
// a turn that fits is one part for one call, the common case. Otherwise greedy: a paragraph
// joins the open part while the part still fits, else closes it and opens the next.
// Exported for the check; the service is its one caller.
// [LAW:no-silent-failure] A paragraph that measures over the quota on its own fits no part;
// thrown, and the service reports it as the turn's failure.
export const packByQuota = async (
  paragraphs: ReadonlyArray<string>,
  summarizer: Pick<Summarizer, "inputQuota" | "measureInputUsage">,
  options: SummarizeOptions,
): Promise<ReadonlyArray<string>> => {
  const usageOf = async (part: ReadonlyArray<string>): Promise<number> =>
    summarizer.measureInputUsage(joinParagraphs(part), options);
  const over = (usage: number): Error =>
    new Error(`a paragraph measures ${usage} against the summarizer's quota of ${summarizer.inputQuota}`);
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
// marked combined. Every round must leave fewer digests than went in, or the summarizer's
// digests are no shorter than its inputs and the turn fails with that reason.
const digestOf = async (input: DigestInput, summarizer: Summarizer, signal: AbortSignal): Promise<Digest> => {
  const round = async (texts: ReadonlyArray<string>, context: string): Promise<ReadonlyArray<string>> => {
    const parts = await packByQuota(texts, summarizer, { context, signal });
    const digests: string[] = [];
    for (const part of parts) digests.push(await summarizer.summarize(part, { context, signal }));
    return digests;
  };
  let digests = await round(input.paragraphs, turnContext(input.speaker));
  const combined = digests.length > 1;
  while (digests.length > 1) {
    const next = await round(digests, COMBINED_CONTEXT);
    if (next.length >= digests.length) {
      throw new Error(`${digests.length} part digests pack into ${next.length} parts, no fewer: the summarizer's digests are no shorter than its inputs`);
    }
    digests = next;
  }
  return { text: digests[0] ?? "", combined };
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
  readonly hash?: Hash;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// One shown turn as the service holds it: its name to callers, its input, and its outcome
// so far — the one place an outcome is written.
interface Entry {
  readonly index: number;
  readonly input: DigestInput;
  outcome: DigestOutcome;
}

// The walk under way: what stops it, and the promise a start answers with.
interface Walk {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

export const createDigestService = ({ dialogue, summarizer, identity, store, hash = contentHash }: DigestServiceConfig): DigestService => {
  const entries: ReadonlyArray<Entry> = dialogue.map((display) => {
    const input = selectDigestInput(display);
    return { index: display.index, input, outcome: wordCount(input) < DIGEST_MIN_WORDS ? { kind: "none" } : { kind: "pending" } };
  });
  const byIndex = new Map(entries.map((entry) => [entry.index, entry]));
  const listeners = new Set<DigestListener>();
  let from = 0;
  let live: Walk | null = null;

  // The outcome is written before any listener hears it, so a listener that throws leaves
  // the outcome right and its throw reaches the caller of start, whose listener it is.
  const settle = (entry: Entry, outcome: DigestOutcome): void => {
    entry.outcome = outcome;
    for (const listener of listeners) listener(entry.index, outcome);
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
    const key = await digestKey(entry.input, identity, hash);
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

  const walk = async (signal: AbortSignal): Promise<void> => {
    for (let entry = next(); entry !== undefined; entry = next()) {
      const outcome = await outcomeOf(entry, signal);
      if (signal.aborted) return;
      settle(entry, outcome);
    }
  };

  const stop = (): void => {
    live?.controller.abort();
    live = null;
  };

  const start = (at: number): Promise<void> => {
    from = at;
    if (live !== null) return live.done;
    const controller = new AbortController();
    const started: Walk = {
      controller,
      done: walk(controller.signal).finally(() => {
        if (live === started) live = null;
      }),
    };
    live = started;
    return started.done;
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
