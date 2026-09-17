// The browser's Summarizer as this page asks for it (slopspot-turn-digest-8xc.44n): a global
// that is not there, one that is not the spec's, the four availabilities and a fifth this
// build does not know, and the download the monitor reports.
// Run: `tsx scripts/summarizer-source-check.ts`.

import {
  DIGEST_OPTIONS,
  NATIVE_IMPLEMENTATION,
  availabilityOf,
  openSummarizer,
  parseAvailability,
  summarizerIdentity,
  summarizerSource,
  type HeldSummarizer,
  type SummarizerSource,
} from "../src/summarizerSource";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// A summarizer the spec would recognise: it answers nothing useful, because nothing here
// asks it to summarize — this file is about getting hold of one.
const heldStub = (): HeldSummarizer => ({
  inputQuota: 1000,
  measureInputUsage: async () => 1,
  summarize: async () => "a digest",
  destroy: () => undefined,
});

console.log("the global: present, absent, or something else wearing the name");
{
  assert("a scope with no Summarizer at all is no source", summarizerSource({}) === null);
  assert("a scope that is not an object is no source", summarizerSource(undefined) === null && summarizerSource("Summarizer") === null);
  assert("a null Summarizer is no source", summarizerSource({ Summarizer: null }) === null);
  assert("a Summarizer that is a bare string is no source", summarizerSource({ Summarizer: "yes" }) === null);
  assert(
    "an object with availability but no create is no source — a half-implemented API is not one to build on",
    summarizerSource({ Summarizer: { availability: () => undefined } }) === null,
  );
  const real = { availability: async () => "available", create: async () => heldStub() };
  assert("an object carrying both is the source itself", summarizerSource({ Summarizer: real }) === real);
  // The spec's Summarizer is a class-like namespace object; a function carrying both statics
  // is the same thing to `typeof` and must read as a source too.
  const asFunction = Object.assign(function Summarizer() {}, real);
  assert("a function carrying both statics is a source", summarizerSource({ Summarizer: asFunction }) === asFunction);
}

console.log("what the browser says it can do");
{
  assert("unavailable", parseAvailability("unavailable") === "unavailable");
  assert("downloadable", parseAvailability("downloadable") === "downloadable");
  assert("downloading", parseAvailability("downloading") === "downloading");
  assert("available", parseAvailability("available") === "available");
  assert("a state this build does not know reads as unavailable", parseAvailability("after-the-heat-death") === "unavailable");
  assert("nothing at all reads as unavailable", parseAvailability(undefined) === "unavailable" && parseAvailability(null) === "unavailable");
}

console.log("the options the browser is asked, and the identity they key");
{
  assert("plain text, so the digest is never markup on the page", DIGEST_OPTIONS.format === "plain-text");
  const asked: unknown[] = [];
  const source: SummarizerSource = {
    availability: async (options) => {
      asked.push(options);
      return "available";
    },
    create: async () => heldStub(),
  };
  const availability = await availabilityOf(source, DIGEST_OPTIONS);
  assert("availability is asked with the very options the summarizer will be made with", asked[0] === DIGEST_OPTIONS);
  assert("and parsed on the way back", availability === "available");

  const identity = summarizerIdentity(DIGEST_OPTIONS, NATIVE_IMPLEMENTATION);
  assert(
    "the identity carries the three options and who answered them",
    identity.type === DIGEST_OPTIONS.type &&
      identity.format === DIGEST_OPTIONS.format &&
      identity.length === DIGEST_OPTIONS.length &&
      identity.implementation === NATIVE_IMPLEMENTATION,
  );
  const other = summarizerIdentity({ ...DIGEST_OPTIONS, length: "long" }, NATIVE_IMPLEMENTATION);
  assert("a different length is a different identity, so a different key", JSON.stringify(identity) !== JSON.stringify(other));
}

console.log("opening one: the download is reported as the browser reports it");
{
  const seen: number[] = [];
  let passed: Parameters<SummarizerSource["create"]>[0] | null = null;
  // The monitor is handed a real EventTarget, so the listener the module adds is the one the
  // browser's own progress events would reach.
  const events = new EventTarget();
  const watching: SummarizerSource = {
    availability: async () => "downloadable",
    create: async (options) => {
      passed = options;
      options.monitor?.(events);
      return heldStub();
    },
  };
  const held = await openSummarizer(watching, DIGEST_OPTIONS, (loaded) => seen.push(loaded));
  const given = passed as Parameters<SummarizerSource["create"]>[0] | null;
  assert("the three options reach create unchanged", given?.type === DIGEST_OPTIONS.type && given.format === DIGEST_OPTIONS.format && given.length === DIGEST_OPTIONS.length);
  assert("a monitor is always offered, so a download can never happen unseen", typeof given?.monitor === "function");
  events.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded: 0.25 }));
  events.dispatchEvent(Object.assign(new Event("downloadprogress"), { loaded: 1 }));
  assert("every report reaches the caller, in order, as the spec's 0..1", seen.join() === "0.25,1");
  assert("the summarizer itself is what comes back", typeof held.summarize === "function" && typeof held.destroy === "function");
}

console.log("a create the browser refuses");
{
  const refusing: SummarizerSource = {
    availability: async () => "downloadable",
    create: async () => {
      throw new Error("Requires a user gesture");
    },
  };
  const refusal = await openSummarizer(refusing, DIGEST_OPTIONS, () => undefined).then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  assert("it rejects with the browser's own reason, never a summarizer that cannot summarize", refusal === "Requires a user gesture");
}

console.log(process.exitCode === 1 ? "summarizer-source-check: FAILED" : "summarizer-source-check: ok");
