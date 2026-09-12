// The neural voice behind the performer seam: the utterance table at the door, seeks in
// the page's coordinates, the position read back in them (slopspot-read-along-a35.1).
// Run: `tsx scripts/neural-performer-check.ts`.
//
// [LAW:behavior-not-structure] What is asserted is the contract the panel drives: which
// unit a seek to an utterance starts, which utterance and span the performer reports, and
// that a script that is not this page's is refused. The real scheduler and the real unit
// player run underneath, over the stub device and a stub port.

import { createNeuralPerformer, passages, positionOf, spotOf, utteranceTable, type NeuralView } from "../src/neuralPerformer";
import type { Mark, PerformerState } from "../src/performer";
import type { Utterance } from "../src/speech";
import { addUnit, emptyManifest, type UnitReport } from "../src/speechManifest";
import { DEFAULT_VOICES, type SynthesisUnit } from "../src/speechScript";
import type { SynthesisPort } from "../src/synthesisClient";
import type { FromWorker, ToWorker } from "../src/synthesisProtocol";
import { SCHEDULE_LEAD_S, openDevice } from "../src/unitPlayer";
import { FRAME_S, frame, StubDevice } from "./playbackStub";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const throws = (label: string, f: () => unknown): void => {
  let threw = false;
  try {
    f();
  } catch {
    threw = true;
  }
  assert(label, threw);
};

// ── fixtures ──────────────────────────────────────────────────────────────────────────

// Three utterances on two turns; the first is long enough for two units. The script's
// units hold CLONES of the utterances, as the worker's structured clone hands them back:
// the same values, never the same objects.
const one: Utterance = { index: 1, anchor: "t1", voice: "user", text: "First sentence here. Second sentence here." };
const two: Utterance = { index: 1, anchor: "t1", voice: "narrator", text: "python code block, 2 lines." };
const three: Utterance = { index: 2, anchor: "t2", voice: "assistant", text: "A reply." };
const utterances = [one, two, three];
const clone = (u: Utterance): Utterance => ({ ...u });
const unit = (utterance: Utterance, start: number, end: number): SynthesisUnit => ({ utterance, start, end, text: utterance.text.slice(start, end) });
const script = ((): SynthesisUnit[] => {
  const [a, b, c] = [clone(one), clone(two), clone(three)];
  return [unit(a, 0, 20), unit(a, 21, 42), unit(b, 0, 27), unit(c, 0, 8)];
})();

// The segment, and the word after a slash when one is claimed.
const describe = (state: PerformerState): string =>
  state.kind === "idle"
    ? "idle"
    : `${state.kind}@${state.at.utterance} ${state.at.segment.charStart}-${state.at.segment.charEnd}${state.at.word === null ? "" : `/${state.at.word.charStart}-${state.at.word.charEnd}`}`;
const at = (utterance: number, char = 0): Mark => ({ utterance, char });

console.log("utteranceTable: the script's passages are the page's utterances, one for one");
{
  assert("passages are utterances, not units", passages(script).length === 3);
  assert("each unit names the utterance it says", utteranceTable(utterances, script).join() === "0,0,1,2");
  throws("a script with a passage the page lacks is refused", () => utteranceTable([one, three], script));
  throws("a script whose passage differs from the page's utterance is refused", () => utteranceTable([one, { ...two, text: "other" }, three], script));
  throws("a script shorter than the page is refused", () => utteranceTable(utterances, script.slice(0, 2)));
}

console.log("spotOf: the position in the page's coordinates");
{
  const table = utteranceTable(utterances, script);
  const view = (player: NeuralView["player"]): NeuralView => ({ player, manifest: emptyManifest(script), holdings: script.map(() => ({ kind: "absent" })), utteranceOf: table });
  assert("idle is idle", describe(spotOf(view({ kind: "idle" }))) === "idle");
  assert("a unit with no record yet reports its whole span and no word", describe(spotOf(view({ kind: "speaking", at: { unitIndex: 1, offsetMs: 0 }, flow: "waiting" }))) === "speaking@0 21-42");
  assert("the second passage's unit reports the second utterance", describe(spotOf(view({ kind: "paused", at: { unitIndex: 2, offsetMs: 0 } }))) === "paused@1 0-27");
  throws("a position past the script is a bug, not a span", () => spotOf(view({ kind: "paused", at: { unitIndex: 9, offsetMs: 0 } })));

  // Unit 0 recorded with word times ("First", "sentence", "here." at 0, 100, 200 ms):
  // the spot claims the word, and a mark in it seeks to the word's time.
  const timed = addUnit(emptyManifest(script), 0, {
    durationMs: 300,
    alignment: { kind: "words", times: [{ startMs: 0, endMs: 100 }, { startMs: 100, endMs: 200 }, { startMs: 200, endMs: 300 }] },
  });
  if (timed.kind !== "added") throw new Error("fixture: the words report was rejected");
  const recorded = { ...view({ kind: "speaking", at: { unitIndex: 0, offsetMs: 150 }, flow: "audio" }), manifest: timed.manifest };
  assert("a recorded unit reports the word under the clock inside its segment", describe(spotOf(recorded)) === "speaking@0 0-20/6-14");

  console.log("positionOf: a mark in the page's text to a unit and an offset");
  const pos = (mark: Mark): string => {
    const p = positionOf(timed.manifest, table, mark);
    return `${p.unitIndex}@${p.offsetMs}`;
  };
  assert("the top of a recorded unit is its start", pos(at(0)) === "0@0");
  assert("a character inside a timed word seeks to when that word begins", pos(at(0, 8)) === "0@100");
  assert("a character in the last word seeks to its start", pos(at(0, 17)) === "0@200");
  assert("a character in the utterance's second unit finds that unit; unrecorded, its start", pos(at(0, 21)) === "1@0" && pos(at(0, 30)) === "1@0");
  assert("another utterance's mark finds its unit", pos(at(1, 5)) === "2@0" && pos(at(2)) === "3@0");
  throws("a mark naming an utterance the page lacks throws", () => positionOf(timed.manifest, table, at(3)));
  throws("a character past the utterance's text throws: not an empty sentence", () => positionOf(timed.manifest, table, at(0, one.text.length)));
  throws("a negative character throws", () => positionOf(timed.manifest, table, at(1, -1)));
}

console.log("createNeuralPerformer: over the real scheduler and player");
{
  const sent: ToWorker[] = [];
  const listeners = new Set<(message: FromWorker) => void>();
  const port: SynthesisPort = {
    send: (message) => sent.push(message),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    errors: () => () => undefined,
    dispose: () => undefined,
    terminate: () => undefined,
  };
  const emit = (message: FromWorker): void => {
    for (const listener of listeners) listener(message);
  };
  const said = (): string => sent.map((m) => (m.kind === "synthesize" ? `synthesize ${m.unitId}` : m.kind === "cancel" ? `cancel ${m.unitId}` : m.kind)).join();
  const report = (durationMs: number): UnitReport => ({ durationMs, alignment: { kind: "unit" } });

  const views: NeuralView[] = [];
  const performer = createNeuralPerformer({ port, script, utterances, voices: DEFAULT_VOICES, device: openDevice(StubDevice), onChange: (view) => views.push(view) });
  const device = StubDevice.instances.at(-1);
  if (device === undefined) throw new Error("the performer did not build a player");

  assert("built idle, nothing requested yet", describe(performer.state()) === "idle" && sent.length === 0);
  assert("the view carries the table", performer.view().utteranceOf.join() === "0,0,1,2");

  performer.send({ kind: "seek", to: at(1) });
  assert("a seek to the second utterance starts its first unit, waiting on synthesis", describe(performer.state()) === "speaking@1 0-27" && said() === "synthesize 2");
  assert("the change is reported with the table attached", views.at(-1)?.utteranceOf.join() === "0,0,1,2" && views.at(-1)?.player.kind === "speaking");

  performer.send({ kind: "pause" });
  assert("pausing holds the place", describe(performer.state()) === "paused@1 0-27");
  performer.send({ kind: "seek", to: at(2) });
  assert("seeking while paused stays paused, at the new utterance; the unit in flight is cancelled for the new one", describe(performer.state()) === "paused@2 0-8" && said() === "synthesize 2,cancel 2,synthesize 3");
  emit({ kind: "cancelled", unitId: 2 });
  performer.send({ kind: "seek", to: at(0, 25) });
  assert("seeking to a character in the first utterance's second sentence holds at that unit", describe(performer.state()) === "paused@0 21-42" && said().endsWith("cancel 3,synthesize 1"));
  performer.send({ kind: "seek", to: at(2) });
  assert("seeking back to a unit the worker has not yet let go of: the place moves, the unwanted unit is cancelled, the request waits", describe(performer.state()) === "paused@2 0-8" && said().endsWith("synthesize 1,cancel 1"));
  emit({ kind: "cancelled", unitId: 3 });
  assert("the worker lets go: the unit is asked for again", said().endsWith("cancel 1,synthesize 3"));
  emit({ kind: "cancelled", unitId: 1 });
  throws("a seek to an utterance the page does not have throws", () => performer.send({ kind: "seek", to: at(3) }));

  performer.send({ kind: "play" });
  emit({ kind: "audio", unitId: 3, frameIndex: 0, pcm: frame(3, 0) });
  emit({ kind: "done", unitId: 3, report: report(FRAME_S * 1000), elapsedMs: 5 });
  assert("audio for the unit: playing the last utterance", describe(performer.state()) === "speaking@2 0-8");
  device.advance(SCHEDULE_LEAD_S + FRAME_S + 0.01);
  assert("the last unit ends: idle", describe(performer.state()) === "idle");

  performer.send({ kind: "play" });
  assert("play from idle starts at the top", describe(performer.state()) === "speaking@0 0-20");

  const before = views.length;
  performer.dispose();
  assert("dispose stops the player and suspends the device; its owner closes it", performer.view().player.kind === "idle" && device.calls.at(-1) === "suspend");
  assert("a disposed performer reports nothing more", views.length === before);
}

console.log(process.exitCode === 1 ? "neural-performer-check: FAILED" : "neural-performer-check: ok");
