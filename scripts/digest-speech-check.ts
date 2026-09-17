// Which turns' digests the narrator has to say (slopspot-turn-digest-8xc.p1n): the reader's
// per-device choice, and the map composed from what the digest service holds at the moment it
// is asked. Run: `tsx scripts/digest-speech-check.ts`.
//
// [LAW:behavior-not-structure] Every assertion is about an observable — what the map carries,
// what the store holds — so a different implementation of the same contract passes.

import { NOTHING_SAID, SAY_KEY, readSaid, sameSaid, spokenDigests, writeSaid } from "../src/digestSpeech";
import type { DigestOutcome, DigestService, DigestTurn } from "../src/turnDigest";
import { memoryPreferences, refusedPreferences } from "./preferenceStub";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const turn = (index: number): DigestTurn => ({ index, input: { speaker: "assistant", paragraphs: ["…"] } });

// The service as this module reads it: one member, answering from a table. A turn the table
// does not name is a turn the service does not hold, and it throws there exactly as the real
// one does.
const serving = (outcomes: ReadonlyMap<number, DigestOutcome>): DigestService => ({
  outcome: (index) => {
    const held = outcomes.get(index);
    if (held === undefined) throw new RangeError(`turn ${index} is not among the dialogue's shown turns`);
    return held;
  },
  subscribe: () => () => undefined,
  start: async () => undefined,
  stop: () => undefined,
});

console.log("\nthe reader's choice, on this device");
{
  const store = memoryPreferences();
  assert("an empty store says them: the default costs no download, so it is on", readSaid(store) && store.keys().length === 0);
  writeSaid(store, false);
  assert("turned off: one key, read back off", !readSaid(store) && store.keys().join() === SAY_KEY);
  writeSaid(store, true);
  assert("turned back on: the key is removed rather than written as a second value", readSaid(store) && store.keys().length === 0);
  store.setItem(SAY_KEY, "quiet");
  assert("a value this build did not write reads as the default", readSaid(store));
  assert("a store that refuses site data reads as the default too", readSaid(refusedPreferences()));
}

console.log("\nwhat the narrator has to say, at the moment it is asked");
{
  const turns = [turn(1), turn(4), turn(7), turn(9)];
  const said = spokenDigests(
    turns,
    serving(
      new Map<number, DigestOutcome>([
        [1, { kind: "ready", text: "A digest of turn one.", combined: false }],
        [4, { kind: "pending" }],
        [7, { kind: "failed", reason: "the summarizer answered nothing" }],
        [9, { kind: "ready", text: "A digest of turn nine, combined.", combined: true }],
      ]),
    ),
  );
  assert("only the turns with a digest are in it", [...said.keys()].join() === "1,9");
  assert("each carries its digest's own text", said.get(1) === "A digest of turn one." && said.get(9) === "A digest of turn nine, combined.");
  assert("a turn still being summarized is simply absent: the narrator never waits", !said.has(4));
  assert("a turn whose digest failed is absent too, not an apology said aloud", !said.has(7));
  assert("that a digest was combined is the card's mark, not a word in the ear", said.get(9) === "A digest of turn nine, combined." && !said.get(9)!.startsWith("Combined"));
}

console.log("\nbefore there is a summarizer at all");
{
  assert("no service is no digests, rather than an outcome invented for a turn nobody looked at", spokenDigests([turn(1), turn(2)], null).size === 0);
  assert("and the reader's no is that same empty map, not a second path through the composition", NOTHING_SAID.size === 0);
}

console.log("\nwhether an ask would say anything new");
{
  const one = new Map([[1, "A digest of turn one."]]);
  assert("the same turns with the same words are the same answer", sameSaid(one, new Map([[1, "A digest of turn one."]])));
  assert("nothing said twice is the same answer, so a page with no digests re-seats nothing", sameSaid(NOTHING_SAID, new Map()));
  assert("a digest that landed is a different answer", !sameSaid(one, new Map([[1, "A digest of turn one."], [2, "And of turn two."]])));
  assert("a digest that changed its words is a different answer", !sameSaid(one, new Map([[1, "Re-derived, and differently worded."]])));
  assert("a digest for another turn entirely is a different answer", !sameSaid(one, new Map([[2, "A digest of turn one."]])));
  assert("and the reader's no, against a page that was saying one, is a different answer", !sameSaid(one, NOTHING_SAID));
}

if (process.exitCode) {
  console.error("\nDigest speech checks FAILED.");
} else {
  console.log("\nAll digest speech checks passed.");
}
