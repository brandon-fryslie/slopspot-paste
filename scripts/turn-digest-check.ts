// The digest service (slopspot-turn-digest-8xc.qbv) over a stub Summarizer whose quota is
// small and a Map for the device: what of a turn is summarized, the word threshold, the quota
// split, the device key across an edit and a change of summarizer, the reading order from a
// mid-paste start, a stop and a re-aim. Run: `tsx scripts/turn-digest-check.ts`.

import type { Overlay, Turn } from "../src/types";
import { deriveViewableDialogue } from "../src/overlay";
import {
  DIGEST_MIN_WORDS,
  createDigestService,
  packByQuota,
  paragraphsOf,
  preferenceDigestStore,
  selectDigestInput,
  wordCount,
  type Digest,
  type DigestOutcome,
  type DigestStore,
  type Summarizer,
  type SummarizerIdentity,
} from "../src/turnDigest";
import { memoryPreferences } from "./preferenceStub";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// ── fixtures ─────────────────────────────────────────────────────────────────────────

// `n` distinct words, so a count is a count and no paragraph equals another.
const words = (n: number, tag: string): string => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");
const countWords = (text: string): number => text.split(/\s+/).filter((w) => w.length > 0).length;

const user = (content: string): Turn => ({ kind: "message", role: "user", content });
const assistant = (content: string): Turn => ({ kind: "message", role: "assistant", content });

const viewable = (turns: ReadonlyArray<Turn>, overlay: Overlay = []) => deriveViewableDialogue({ turns, overlay });

const IDENTITY: SummarizerIdentity = { type: "tldr", format: "plain-text", length: "short", implementation: "stub" };

interface Call {
  readonly input: string;
  readonly context: string | undefined;
}

// A Summarizer that counts words as its units and answers a digest naming the count; every
// call is recorded, and an aborted signal is honoured as the spec's would be.
const stubSummarizer = (inputQuota: number) => {
  const calls: Call[] = [];
  const measures: Call[] = [];
  const summarizer: Summarizer = {
    inputQuota,
    measureInputUsage: async (input, options) => {
      measures.push({ input, context: options?.context });
      return countWords(input);
    },
    summarize: async (input, options) => {
      options?.signal?.throwIfAborted();
      calls.push({ input, context: options?.context });
      return `«${countWords(input)} words»`;
    },
  };
  return { summarizer, calls, measures };
};

// A Summarizer that stalls until released, rejects as the spec's does when its signal
// aborts, and announces each call's arrival — a check waits on that, never on a tick, so it
// does not depend on how busy the machine is [LAW:no-ambient-temporal-coupling].
const stallingSummarizer = () => {
  let release: (() => void) | null = null;
  let announce: (() => void) | null = null;
  const calls: string[] = [];
  const summarizer: Summarizer = {
    inputQuota: 1_000,
    measureInputUsage: async (input) => countWords(input),
    summarize: (input, options) =>
      new Promise((resolve, reject) => {
        calls.push(input);
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
        release = () => resolve("released");
        announce?.();
      }),
  };
  return {
    summarizer,
    calls,
    nextCall: (): Promise<void> => new Promise((resolve) => void (announce = resolve)),
    release: (): void => release?.(),
  };
};

const mapStore = () => {
  const held = new Map<string, Digest>();
  const store: DigestStore = {
    get: async (key) => held.get(key),
    put: async (key, digest) => void held.set(key, digest),
  };
  return { store, held };
};

const settled: DigestOutcome["kind"][] = ["none", "ready", "failed"];
const isSettled = (outcome: DigestOutcome): boolean => settled.includes(outcome.kind);

// ── input selection ──────────────────────────────────────────────────────────────────

console.log("what of a turn is summarized: its readable spine prose, as the reader sees it");
{
  const secret = words(DIGEST_MIN_WORDS, "secret");
  const dialogue = viewable(
    [
      user("Explain the plan.\n\nIn detail."),
      { kind: "thinking", content: "private reasoning " + words(50, "think") },
      { kind: "tool-call", tool: "Read", args: "src/x.ts", output: null },
      assistant("The plan is short.\n\n\nAnd this is its second paragraph."),
      { kind: "turn-summary", text: "SOURCE SUMMARY " + words(20, "sum") },
      user(secret),
    ],
    [{ kind: "hide", target: { kind: "turn", index: 2 } }],
  );
  const [first, second, third] = dialogue;
  assert("the dialogue shows three turns", dialogue.length === 3 && first !== undefined && second !== undefined && third !== undefined);
  if (first === undefined || second === undefined || third === undefined) throw new Error("fixture");

  const spoken = selectDigestInput(first);
  assert("a user turn: its speaker and its paragraphs at the blank line", spoken.speaker === "user" && spoken.paragraphs.join("|") === "Explain the plan.|In detail.");

  const reply = selectDigestInput(second);
  assert("an assistant turn: the assistant's spine text only, at its paragraphs", reply.speaker === "assistant" && reply.paragraphs.join("|") === "The plan is short.|And this is its second paragraph.");
  const replyText = reply.paragraphs.join(" ");
  assert("thinking and the tool call are not input", !replyText.includes("think0") && !replyText.includes("Read"));
  assert("the source's own turn-summary block is not input", !replyText.includes("SOURCE SUMMARY"));

  const hidden = selectDigestInput(third);
  assert("a hidden turn's input is its marker, never the original", hidden.paragraphs.join("|") === "[redacted]" && !hidden.paragraphs.join().includes("secret0"));
}

console.log("a code-heavy turn: a fenced block is one paragraph, its blank lines inside it");
{
  const fenced = "Here is the fix:\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nDone.";
  const paragraphs = paragraphsOf(fenced);
  assert("prose, the whole fence, prose", paragraphs.length === 3 && paragraphs[1] === "```ts\nconst a = 1;\n\nconst b = 2;\n```");
  const tilde = paragraphsOf("~~~\n```\n\nstill inside\n~~~\n\nafter");
  assert("a tilde fence is closed by a tilde fence, not by backticks inside it", tilde.length === 2 && tilde[0]?.endsWith("~~~") === true && tilde[1] === "after");
  const nested = paragraphsOf("````md\ntext\n```\nmore\n````\n\nafter one\n\nafter two");
  assert("a shorter fence inside a longer one does not close it (CommonMark)", nested.length === 3 && nested[1] === "after one");
  const info = paragraphsOf("```ts\ncode\n```js\nmore\n```\n\nafter");
  assert("a fence line with an info string opens, never closes", info.length === 2 && info[1] === "after");
  const unclosed = paragraphsOf("```\nnever closed\n\nstill code");
  assert("a fence never closed runs to the end as one paragraph", unclosed.length === 1);
  const trace = [words(10, "before"), "```\n" + words(40, "frame") + "\n```", words(10, "after")].join("\n\n");
  const input = selectDigestInput(viewable([assistant(trace)])[0]!);
  assert("the trace counts toward the threshold and stays one paragraph", input.paragraphs.length === 3 && wordCount(input) === 62);
}

console.log("the threshold: a turn one word short is its own digest");
{
  const dialogue = viewable([user(words(DIGEST_MIN_WORDS - 1, "a")), user(words(DIGEST_MIN_WORDS, "b"))]);
  const { summarizer } = stubSummarizer(1_000);
  const service = createDigestService({ dialogue, summarizer, identity: IDENTITY, store: mapStore().store });
  assert(`${DIGEST_MIN_WORDS - 1} words: none`, service.outcome(0).kind === "none");
  assert(`${DIGEST_MIN_WORDS} words: pending`, service.outcome(1).kind === "pending");
  assert("wordCount counts what the stub measures", wordCount(selectDigestInput(dialogue[1]!)) === DIGEST_MIN_WORDS);
  let threw = false;
  try {
    service.outcome(7);
  } catch (error) {
    threw = error instanceof RangeError;
  }
  assert("a turn the dialogue does not show is a RangeError", threw);
}

// ── quota ────────────────────────────────────────────────────────────────────────────

console.log("the quota split: parts at paragraph boundaries, each under the quota");
{
  const { summarizer, measures } = stubSummarizer(25);
  const paragraphs = [words(10, "p"), words(10, "q"), words(10, "r"), words(10, "s"), words(20, "t")];
  const parts = await packByQuota(paragraphs, summarizer, { context: "ctx" });
  assert("five paragraphs of 10,10,10,10,20 words under a quota of 25 pack as [p q] [r s] [t]", parts.length === 3 && parts.map(countWords).join() === "20,20,20");
  assert("a part joins its paragraphs at a blank line", parts[0] === `${paragraphs[0]}\n\n${paragraphs[1]}`);
  assert("every measure is taken under the context the part will be summarized with", measures.length > 0 && measures.every((m) => m.context === "ctx"));
  measures.length = 0;
  const whole = await packByQuota([words(10, "p"), words(10, "q")], summarizer, {});
  assert("paragraphs that fit together are one part after one measure", whole.length === 1 && measures.length === 1);
  let reason = "";
  try {
    await packByQuota([words(30, "big")], summarizer, {});
  } catch (error) {
    reason = error instanceof Error ? error.message : "";
  }
  assert("a paragraph over the quota on its own is thrown with both numbers", reason.includes("30") && reason.includes("25"));
}

console.log("a long turn: each part digested, the digests digested together, marked combined");
{
  const dialogue = viewable([assistant([words(40, "a"), words(40, "b"), words(40, "c")].join("\n\n"))]);
  const { summarizer, calls, measures } = stubSummarizer(90);
  const service = createDigestService({ dialogue, summarizer, identity: IDENTITY, store: mapStore().store });
  await service.start(0);
  const outcome = service.outcome(0);
  assert("ready and combined", outcome.kind === "ready" && outcome.combined && outcome.text === "«4 words»");
  assert("three summarize calls: two parts, then their digests", calls.length === 3 && countWords(calls[0]!.input) === 80 && countWords(calls[1]!.input) === 40 && calls[2]!.input === "«80 words»\n\n«40 words»");
  assert("the parts carry the speaker, the combination says it combines", calls[0]!.context?.includes("assistant's reply") === true && calls[2]!.context?.includes("one long turn") === true);
  const contexts = new Set(measures.map((m) => m.context));
  assert("the measures carry the same two contexts", contexts.size === 2 && [...contexts].every((c) => c !== undefined));
}

console.log("a very long turn: the part digests are packed and digested in rounds until one remains");
{
  const dialogue = viewable([assistant(Array.from({ length: 100 }, (_, i) => words(40, `p${i}_`)).join("\n\n"))]);
  const { summarizer, calls } = stubSummarizer(90);
  const service = createDigestService({ dialogue, summarizer, identity: IDENTITY, store: mapStore().store });
  await service.start(0);
  const outcome = service.outcome(0);
  assert("50 parts, then 2, then 1: ready and combined", outcome.kind === "ready" && outcome.combined && calls.length === 53 && outcome.text === "«4 words»");
}

console.log("a Summarizer whose digests are no shorter than its inputs: the turn fails with that reason");
{
  const dialogue = viewable([assistant([words(40, "a"), words(40, "b"), words(40, "c")].join("\n\n"))]);
  const summarizer: Summarizer = {
    inputQuota: 90,
    measureInputUsage: async (input) => countWords(input),
    summarize: async (input) => input,
  };
  const service = createDigestService({ dialogue, summarizer, identity: IDENTITY, store: mapStore().store });
  await service.start(0);
  const outcome = service.outcome(0);
  assert("failed, naming the rounds that made no progress", outcome.kind === "failed" && outcome.reason.includes("no shorter"));
}

console.log("a Summarizer whose digests shrink but cannot yet pair: another round, not a failure");
{
  // Six paragraphs of 30 words under a quota of 40; every digest is six tenths of its input,
  // so the digests go 18 → three of 22 (still no pair under 40) → three of 14 → one.
  const dialogue = viewable([assistant(Array.from({ length: 6 }, (_, i) => words(30, `p${i}_`)).join("\n\n"))]);
  const summarizer: Summarizer = {
    inputQuota: 40,
    measureInputUsage: async (input) => countWords(input),
    summarize: async (input) => words(Math.ceil(countWords(input) * 0.6), "d"),
  };
  const service = createDigestService({ dialogue, summarizer, identity: IDENTITY, store: mapStore().store });
  await service.start(0);
  const outcome = service.outcome(0);
  assert("ready and combined after the rounds", outcome.kind === "ready" && outcome.combined);
}

console.log("a Summarizer that answers nothing: failed, never a blank kept as the digest");
{
  const dialogue = viewable([user(words(100, "a"))]);
  const summarizer: Summarizer = {
    inputQuota: 1_000,
    measureInputUsage: async (input) => countWords(input),
    summarize: async () => "  ",
  };
  const { store, held } = mapStore();
  const service = createDigestService({ dialogue, summarizer, identity: IDENTITY, store });
  await service.start(0);
  const outcome = service.outcome(0);
  assert("failed with the reason, nothing kept", outcome.kind === "failed" && outcome.reason.includes("answered nothing") && held.size === 0);
}

console.log("a part digest over the quota on its own: the reason names a part digest, not a paragraph");
{
  const dialogue = viewable([assistant([words(40, "a"), words(40, "b"), words(40, "c")].join("\n\n"))]);
  const summarizer: Summarizer = {
    inputQuota: 90,
    measureInputUsage: async (input) => countWords(input),
    summarize: async () => words(100, "long"),
  };
  const service = createDigestService({ dialogue, summarizer, identity: IDENTITY, store: mapStore().store });
  await service.start(0);
  const outcome = service.outcome(0);
  assert("failed: a part digest measures 100 against 90", outcome.kind === "failed" && outcome.reason.startsWith("a part digest measures 100"));
}

console.log("a turn that fits: one measure, one call, not combined; a paragraph that never fits: failed, with the reason");
{
  const dialogue = viewable([user(words(100, "a")), user([words(40, "b"), words(400, "c")].join("\n\n"))]);
  const { summarizer, calls, measures } = stubSummarizer(200);
  const service = createDigestService({ dialogue, summarizer, identity: IDENTITY, store: mapStore().store });
  await service.start(0);
  const fit = service.outcome(0);
  const over = service.outcome(1);
  assert("one call, ready, not combined", fit.kind === "ready" && !fit.combined && calls.length === 1);
  assert("the fitting turn was measured once", measures.filter((m) => m.input.startsWith("a0 ")).length === 1);
  assert("failed with the paragraph's measure and the quota", over.kind === "failed" && over.reason.includes("400") && over.reason.includes("200"));
}

console.log("a Summarizer that throws: the turn fails with its reason, the walk goes on");
{
  const dialogue = viewable([user(words(100, "a")), user(words(100, "b")), user(words(100, "c"))]);
  let call = 0;
  const summarizer: Summarizer = {
    inputQuota: 1_000,
    measureInputUsage: async (input) => countWords(input),
    summarize: async () => {
      call += 1;
      if (call === 1) throw new DOMException("The model is not ready.", "NotReadableError");
      if (call === 2) throw new DOMException("The summarizer was destroyed.", "AbortError");
      return "fine";
    },
  };
  const service = createDigestService({ dialogue, summarizer, identity: IDENTITY, store: mapStore().store });
  await service.start(0);
  const failed = service.outcome(0);
  const destroyed = service.outcome(1);
  assert("the first turn failed with the Summarizer's message", failed.kind === "failed" && failed.reason === "The model is not ready.");
  assert("the Summarizer's own abort is the second turn's failure, not the walk's stop", destroyed.kind === "failed" && destroyed.reason === "The summarizer was destroyed.");
  assert("the third turn is ready", service.outcome(2).kind === "ready");
}

console.log("a listener that throws: the outcome is already right, the others still hear it, the throw is the caller's");
{
  const dialogue = viewable([user(words(100, "a")), user(words(100, "b")), user(words(100, "c"))]);
  const { summarizer } = stubSummarizer(1_000);
  const service = createDigestService({ dialogue, summarizer, identity: IDENTITY, store: mapStore().store });
  let thrown = true;
  let resumed: Promise<void> | null = null;
  service.subscribe(() => {
    if (thrown) {
      thrown = false;
      // A start queued from the throwing listener, as a card re-rendering on the outcome might.
      queueMicrotask(() => void (resumed = service.start(2)));
      throw new Error("render blew up");
    }
  });
  const heard: number[] = [];
  service.subscribe((index) => heard.push(index));
  let caught = "";
  await service.start(0).catch((error: unknown) => void (caught = error instanceof Error ? error.message : ""));
  assert("start rejects with the listener's error; the turn it heard is ready, not failed; the other listener heard it", caught === "render blew up" && service.outcome(0).kind === "ready" && heard.join() === "0");
  await resumed;
  assert("the start queued from the listener opened a new walk that finished the rest, from t2", heard.join() === "0,2,1" && dialogue.every((d) => service.outcome(d.index).kind === "ready"));
}

// ── the device key ───────────────────────────────────────────────────────────────────

console.log("the device key: a second visit is a hit; an edit or another summarizer is a miss");
{
  const turns = [user(words(100, "a")), user(words(100, "b"))];
  const { store, held } = mapStore();
  const first = stubSummarizer(1_000);
  await createDigestService({ dialogue: viewable(turns), summarizer: first.summarizer, identity: IDENTITY, store }).start(0);
  assert("two digests made and kept", first.calls.length === 2 && held.size === 2);

  const again = stubSummarizer(1_000);
  const revisit = createDigestService({ dialogue: viewable(turns), summarizer: again.summarizer, identity: IDENTITY, store });
  await revisit.start(0);
  assert("the same paste again: both ready from the device, no summarize call", again.calls.length === 0 && revisit.outcome(0).kind === "ready" && revisit.outcome(1).kind === "ready");

  const edited = stubSummarizer(1_000);
  await createDigestService({ dialogue: viewable([turns[0]!, user(words(100, "b") + " more")]), summarizer: edited.summarizer, identity: IDENTITY, store }).start(0);
  assert("an edited turn misses; the unedited one still hits", edited.calls.length === 1 && countWords(edited.calls[0]!.input) === 101 && held.size === 3);

  const folded = stubSummarizer(1_000);
  await createDigestService({ dialogue: viewable(turns, [{ kind: "collapse", target: { kind: "turn", index: 0 } }]), summarizer: folded.summarizer, identity: IDENTITY, store }).start(0);
  assert("a fold changes no readable text, so it hits", folded.calls.length === 0);

  const other = stubSummarizer(1_000);
  await createDigestService({ dialogue: viewable(turns), summarizer: other.summarizer, identity: { ...IDENTITY, implementation: "polyfill/gemma-3-270m" }, store }).start(0);
  assert("another summarizer identity misses both", other.calls.length === 2 && held.size === 5);
}

console.log("the preference-store adapter: a kept digest round-trips; a value this build did not write reads as absent");
{
  const preferences = memoryPreferences();
  const store = preferenceDigestStore(preferences);
  await store.put("k1", { text: "a digest", combined: true });
  const kept = await store.get("k1");
  assert("round-trips under a prefixed key, and the kept list names it", kept?.text === "a digest" && kept.combined && preferences.keys().sort().join() === "digest-kept,digest.k1");
  preferences.setItem("digest.k2", "not json");
  preferences.setItem("digest.k3", JSON.stringify({ text: 5 }));
  assert("garbage and a wrong shape read as absent", (await store.get("k2")) === undefined && (await store.get("k3")) === undefined);
  assert("an unknown key reads as absent", (await store.get("k4")) === undefined);
}

console.log("the adapter keeps a bounded number of digests, the oldest out first");
{
  const preferences = memoryPreferences();
  const store = preferenceDigestStore(preferences, 2);
  const digest = (text: string): Digest => ({ text, combined: false });
  await store.put("k1", digest("one"));
  await store.put("k2", digest("two"));
  await store.put("k1", digest("one again"));
  await store.put("k3", digest("three"));
  assert("a re-put digest is newest again, so the other is the one evicted", (await store.get("k2")) === undefined && (await store.get("k1"))?.text === "one again" && (await store.get("k3"))?.text === "three");
  assert("the device holds two digests and the kept list", preferences.keys().sort().join() === "digest-kept,digest.k1,digest.k3");
  const refusing = memoryPreferences();
  let refuse = false;
  const flaky = preferenceDigestStore({
    getItem: (key) => refusing.getItem(key),
    setItem: (key, value) => void (refuse ? undefined : refusing.setItem(key, value)),
    removeItem: (key) => refusing.removeItem(key),
  }, 2);
  await flaky.put("k1", digest("one"));
  refuse = true;
  await flaky.put("k2", digest("two"));
  assert("a device that refuses the kept list's write keeps no digest the list cannot name", refusing.keys().sort().join() === "digest-kept,digest.k1");
  preferences.setItem("digest-kept", "not a list");
  await store.put("k4", digest("four"));
  assert("a kept list this build did not write starts over", (await store.get("k4"))?.text === "four" && preferences.getItem("digest-kept") === JSON.stringify(["k4"]));
}

// ── order, stop and re-aim ───────────────────────────────────────────────────────────

console.log("the reading order: from the reader's turn to the end, then the start; short turns skipped");
{
  const dialogue = viewable([user(words(100, "a")), user("short"), user(words(100, "c")), user(words(100, "d")), user(words(100, "e"))]);
  const { summarizer } = stubSummarizer(1_000);
  const service = createDigestService({ dialogue, summarizer, identity: IDENTITY, store: mapStore().store });
  const seen: number[] = [];
  const unsubscribe = service.subscribe((index, outcome) => {
    if (outcome.kind === "ready") seen.push(index);
  });
  await service.start(3);
  assert("from t3: 3, 4, then 0, 2 — t1 is short and never derived", seen.join() === "3,4,0,2");
  unsubscribe();
  await service.start(0);
  assert("every turn settled, and an unsubscribed listener hears nothing more", dialogue.every((d) => isSettled(service.outcome(d.index))) && seen.length === 4);
}

console.log("the reading order through a feature overlay: indices are the turns' own");
{
  const dialogue = viewable(
    [user(words(100, "a")), user(words(100, "b")), user(words(100, "c"))],
    [{ kind: "feature", target: { kind: "turn", index: 0 } }, { kind: "feature", target: { kind: "turn", index: 2 } }],
  );
  const { summarizer } = stubSummarizer(1_000);
  const service = createDigestService({ dialogue, summarizer, identity: IDENTITY, store: mapStore().store });
  const seen: number[] = [];
  service.subscribe((index) => seen.push(index));
  await service.start(1);
  assert("from t1, which is not shown: the next shown turn first — 2, then 0", seen.join() === "2,0");
  const fresh = createDigestService({ dialogue, summarizer, identity: IDENTITY, store: mapStore().store });
  const past: number[] = [];
  fresh.subscribe((index) => past.push(index));
  await fresh.start(9);
  assert("a start past every shown turn reads from the start — 0, then 2", past.join() === "0,2");
}

console.log("a stop: the derivation under way is abandoned, the turn stays pending, a new start resumes");
{
  const dialogue = viewable([user(words(100, "a")), user(words(100, "b"))]);
  const stub = stallingSummarizer();
  const service = createDigestService({ dialogue, summarizer: stub.summarizer, identity: IDENTITY, store: mapStore().store });
  const firstCall = stub.nextCall();
  const walk = service.start(0);
  await firstCall;
  assert("the first turn's summarize is under way", stub.calls.length === 1 && service.outcome(0).kind === "pending");
  service.stop();
  await walk;
  assert("stopped: the walk resolves, the turn is still pending, the second was never asked", service.outcome(0).kind === "pending" && service.outcome(1).kind === "pending" && stub.calls.length === 1);

  const secondCall = stub.nextCall();
  const second = service.start(1);
  await secondCall;
  assert("a new start from t1 asks for t1", stub.calls.length === 2 && stub.calls[1]?.startsWith("b0 ") === true);
  const thirdCall = stub.nextCall();
  stub.release();
  await thirdCall;
  stub.release();
  await second;
  assert("both ready once released", service.outcome(1).kind === "ready" && service.outcome(0).kind === "ready");
}

console.log("a stop while the digest is being kept: nothing settles after the stop");
{
  const dialogue = viewable([user(words(100, "a"))]);
  const { summarizer } = stubSummarizer(1_000);
  let releasePut: (() => void) | null = null;
  let putArrived: (() => void) | null = null;
  const arrival = new Promise<void>((resolve) => void (putArrived = resolve));
  const store: DigestStore = {
    get: async () => undefined,
    put: () =>
      new Promise((resolve) => {
        releasePut = () => resolve();
        putArrived?.();
      }),
  };
  const service = createDigestService({ dialogue, summarizer, identity: IDENTITY, store });
  const heard: number[] = [];
  service.subscribe((index) => heard.push(index));
  const walk = service.start(0);
  await arrival;
  service.stop();
  releasePut!();
  await walk;
  assert("the walk resolves with the turn still pending and no listener told", service.outcome(0).kind === "pending" && heard.length === 0);
}

console.log("a start during a walk re-aims it: the derivation in flight completes, the walk goes on from the new turn");
{
  const dialogue = viewable([user(words(100, "a")), user(words(100, "b")), user(words(100, "c"))]);
  const stub = stallingSummarizer();
  const service = createDigestService({ dialogue, summarizer: stub.summarizer, identity: IDENTITY, store: mapStore().store });
  const seen: number[] = [];
  service.subscribe((index) => seen.push(index));
  const firstCall = stub.nextCall();
  const first = service.start(0);
  await firstCall;
  const second = service.start(2);
  assert("the second start answers with the same walk and asks nothing new", first === second && stub.calls.length === 1);
  const secondCall = stub.nextCall();
  stub.release();
  await secondCall;
  assert("t0's work was kept, and the walk went on to t2", seen.join() === "0" && stub.calls[1]?.startsWith("c0 ") === true);
  const thirdCall = stub.nextCall();
  stub.release();
  await thirdCall;
  stub.release();
  await second;
  assert("then t1: every turn ready, each derived once", seen.join() === "0,2,1" && stub.calls.length === 3);
}

console.log(process.exitCode === 1 ? "turn-digest-check: FAILED" : "turn-digest-check: ok");
