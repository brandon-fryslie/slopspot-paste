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
// reason; a Summarizer that throws, a paragraph no split can fit under the quota, or a
// combined input still over it all land there, and the turn's text is unaffected. A short
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
// paragraphs — the grain the quota split cuts at, so a part never ends mid-sentence.
export type Speaker = "user" | "system" | "assistant";
export interface DigestInput {
  readonly speaker: Speaker;
  readonly paragraphs: ReadonlyArray<string>;
}

// [LAW:effects-at-boundaries] Pure: the viewable node's spine prose, split at its blank lines.
// nodeVisibleProse joins an assistant turn's spine blocks with a blank line, so a block
// boundary is a paragraph boundary here by construction.
export const selectDigestInput = (display: DisplayNode): DigestInput => ({
  speaker: display.node.kind === "spoken" ? display.node.role : "assistant",
  paragraphs: nodeVisibleProse(display.node)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0),
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
// those units, and the summary of an input. Nothing of create(), availability() or the
// download is here — a Summarizer arrives already made.
export interface Summarizer {
  readonly inputQuota: number;
  measureInputUsage(input: string, options?: { readonly signal?: AbortSignal }): Promise<number>;
  summarize(input: string, options?: { readonly context?: string; readonly signal?: AbortSignal }): Promise<string>;
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

export const preferenceDigestStore = (store: PreferenceStore): DigestStore => ({
  get: async (key) => parseDigest(store.getItem(STORE_PREFIX + key)),
  put: async (key, digest) => store.setItem(STORE_PREFIX + key, JSON.stringify(digest)),
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

// [LAW:dataflow-not-control-flow] Greedy packing of paragraphs into parts that each measure
// under the quota: a paragraph joins the open part while the part still fits, else closes it
// and opens the next. Exported for the check; the service is its one caller.
// [LAW:no-silent-failure] A paragraph that measures over the quota on its own fits no part;
// thrown, and the service reports it as the turn's failure.
export const packByQuota = async (
  paragraphs: ReadonlyArray<string>,
  summarizer: Pick<Summarizer, "inputQuota" | "measureInputUsage">,
  signal: AbortSignal,
): Promise<ReadonlyArray<string>> => {
  const usageOf = async (part: ReadonlyArray<string>): Promise<number> =>
    summarizer.measureInputUsage(joinParagraphs(part), { signal });
  const parts: string[][] = [];
  let open: string[] = [];
  for (const paragraph of paragraphs) {
    if ((await usageOf([...open, paragraph])) <= summarizer.inputQuota) {
      open.push(paragraph);
      continue;
    }
    const alone = await usageOf([paragraph]);
    if (alone > summarizer.inputQuota) {
      throw new Error(`a paragraph measures ${alone} against the summarizer's quota of ${summarizer.inputQuota}`);
    }
    parts.push(open);
    open = [paragraph];
  }
  parts.push(open);
  return parts.map(joinParagraphs);
};

// One turn's digest: its parts summarized one at a time, and when there is more than one,
// their digests summarized together as the turn's, marked combined.
const digestOf = async (input: DigestInput, summarizer: Summarizer, signal: AbortSignal): Promise<Digest> => {
  const context = turnContext(input.speaker);
  const parts = await packByQuota(input.paragraphs, summarizer, signal);
  const digests: string[] = [];
  for (const part of parts) digests.push(await summarizer.summarize(part, { context, signal }));
  if (digests.length === 1) return { text: digests[0] ?? "", combined: false };
  const joined = joinParagraphs(digests);
  const usage = await summarizer.measureInputUsage(joined, { signal });
  if (usage > summarizer.inputQuota) {
    throw new Error(`the ${digests.length} part digests together measure ${usage} against the summarizer's quota of ${summarizer.inputQuota}`);
  }
  return { text: await summarizer.summarize(joined, { context: COMBINED_CONTEXT, signal }), combined: true };
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
  // end, then from the start up to it; one at a time. A start while one is under way
  // abandons the earlier one: the service is the one owner of which derivation is live
  // [LAW:no-ambient-temporal-coupling]. Resolves when the walk ends or is abandoned.
  start(from: number): Promise<void>;
  // Abandon the derivation under way, as when the page leaves.
  stop(): void;
}

export interface DigestServiceConfig {
  readonly dialogue: ViewableDialogue;
  readonly summarizer: Summarizer;
  readonly identity: SummarizerIdentity;
  readonly store: DigestStore;
  readonly hash?: Hash;
}

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// One shown turn as the service holds it: its name to callers, its input, and its outcome
// so far — the one place an outcome is written.
interface Entry {
  readonly index: number;
  readonly input: DigestInput;
  outcome: DigestOutcome;
}

export const createDigestService = ({ dialogue, summarizer, identity, store, hash = contentHash }: DigestServiceConfig): DigestService => {
  const entries: ReadonlyArray<Entry> = dialogue.map((display) => {
    const input = selectDigestInput(display);
    return { index: display.index, input, outcome: wordCount(input) < DIGEST_MIN_WORDS ? { kind: "none" } : { kind: "pending" } };
  });
  const byIndex = new Map(entries.map((entry) => [entry.index, entry]));
  const listeners = new Set<DigestListener>();
  let live: AbortController | null = null;

  const settle = (entry: Entry, outcome: DigestOutcome): void => {
    entry.outcome = outcome;
    for (const listener of listeners) listener(entry.index, outcome);
  };

  // A kept digest, or a fresh one that is then kept; the signal is read after every await so
  // an abandoned walk settles nothing after its stop.
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

  const stop = (): void => {
    live?.abort();
    live = null;
  };

  const start = async (from: number): Promise<void> => {
    stop();
    const controller = new AbortController();
    live = controller;
    const { signal } = controller;
    // The reading order: the first shown turn at or after `from`, to the end, then the rest
    // from the start. A `from` past every shown turn reads from the start.
    const at = Math.max(0, entries.findIndex((entry) => entry.index >= from));
    const order = [...entries.slice(at), ...entries.slice(0, at)].filter((entry) => entry.outcome.kind === "pending");
    for (const entry of order) {
      try {
        signal.throwIfAborted();
        settle(entry, { kind: "ready", ...(await derive(entry, signal)) });
      } catch (error) {
        if (isAbort(error)) return;
        settle(entry, { kind: "failed", reason: reasonOf(error) });
      }
    }
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
