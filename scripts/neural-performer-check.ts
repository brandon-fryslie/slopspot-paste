// The neural voice behind the performer seam: the utterance table at the door, seeks by a
// time on the conversation's clock, the position read back as one, and a seek into the
// timeline's gap between speakers (slopspot-read-along-a35.1, slopspot-read-along-a35.1ni). Run:
// `tsx scripts/neural-performer-check.ts`.
//
// [LAW:behavior-not-structure] What is asserted is the contract the panel drives: which
// unit a seek to a time starts and at what offset, what time the performer reports for a
// player position, and that a script that is not
// this page's is refused. The real scheduler and the real unit player run underneath, over
// the stub device and a stub port.

import { createNeuralPerformer, passages, positionAt, stateOf, timeOf, utteranceTable, type NeuralView } from "../src/neuralPerformer";
import type { PerformerState } from "../src/performer";
import type { Utterance } from "../src/speech";
import { addUnit, emptyManifest, type Manifest, type UnitReport } from "../src/speechManifest";
import type { SynthesisUnit } from "../src/speechScript";
import { DEFAULT_VOICES } from "../src/voiceChoice";
import type { SynthesisPort } from "../src/synthesisClient";
import type { FromWorker, ToWorker } from "../src/synthesisProtocol";
import { SCHEDULE_LEAD_S, openDevice } from "../src/unitPlayer";
import { GAP_MS, speechLegs, spotAt, spotIn, timeAt, timelineOfScript } from "../src/timeline";
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
const table = utteranceTable(utterances, script);

// The state as "kind@ms", the time rounded to the millisecond.
const describe = (state: PerformerState): string => (state.kind === "idle" ? "idle" : `${state.kind}@${Math.round(state.atMs)}`);
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

console.log("utteranceTable: the script's passages are the page's utterances, one for one");
{
  assert("passages are utterances, not units", passages(script).length === 3);
  assert("each unit names the utterance it says", table.join() === "0,0,1,2");
  throws("a script with a passage the page lacks is refused", () => utteranceTable([one, three], script));
  throws("a script whose passage differs from the page's utterance is refused", () => utteranceTable([one, { ...two, text: "other" }, three], script));
  throws("a script shorter than the page is refused", () => utteranceTable(utterances, script.slice(0, 2)));
}

console.log("timeOf and positionAt: the pipeline's unit and offset against the conversation's clock, both ways");
{
  // Every unit measured at 1000 ms: the clock is 0–1000 unit 0, 1000–2000 unit 1,
  // 2000–3000 unit 2, then the gap, then 3500–4500 unit 3.
  const measured = [0, 1, 2, 3].reduce((manifest: Manifest, index) => {
    const added = addUnit(manifest, index, { durationMs: 1000, alignment: { kind: "unit" } });
    if (added.kind !== "added") throw new Error(`fixture: unit ${index} was ${added.kind}`);
    return added.manifest;
  }, emptyManifest(script));
  const line = timelineOfScript(measured, table);
  const units = speechLegs(line);
  assert("the fixture's clock is as described", line.totalMs === 4000 + GAP_MS && timeAt(line, { utterance: 2, char: 0 }) === 3000 + GAP_MS);
  assert("a unit's offset is its leg's start plus the offset", timeOf(units, { unitIndex: 1, offsetMs: 250 }) === 1250 && timeOf(units, { unitIndex: 3, offsetMs: 0 }) === 3000 + GAP_MS);
  assert("the gap is the timeline's, no unit's: nothing is painted in it", spotAt(line, 3200) === null);
  assert("an offset past the unit's leg reads as the leg's end: the clock never runs ahead of the timeline it is laid on", timeOf(units, { unitIndex: 2, offsetMs: 1200 }) === 3000);
  throws("a unit the timeline has no leg for is a player built over another script", () => timeOf(units, { unitIndex: 9, offsetMs: 0 }));
  const pos = (ms: number): string => {
    const p = positionAt(units, ms);
    return `${p.unitIndex}@${Math.round(p.offsetMs)}`;
  };
  assert("a time inside a unit is that unit and the offset", pos(1250) === "1@250" && pos(0) === "0@0");
  assert("a time inside the gap seeks to the first sample of the unit that follows it, as a mark in silence names the character to come", pos(3200) === "3@0" && pos(3000) === "3@0" && pos(3000 + GAP_MS) === "3@0");
  assert("before the start is the first unit's start; past the end is the last unit's end", pos(-500) === "0@0" && pos(9000) === "3@1000");
  assert("the two are inverse over every unit's audio", [0, 1, 2, 3].every((unitIndex) => [0, 333, 999].every((offsetMs) => near(positionAt(units, timeOf(units, { unitIndex, offsetMs })).offsetMs, offsetMs))));
  throws("a script with no units has nothing to seek", () => positionAt([], 0));
  // Unit 2 unmeasured: a guess is not a place in audio nobody has heard.
  const partly = timelineOfScript([0, 1, 3].reduce((manifest: Manifest, index) => {
    const added = addUnit(manifest, index, { durationMs: 1000, alignment: { kind: "unit" } });
    if (added.kind !== "added") throw new Error(`fixture: unit ${index} was ${added.kind}`);
    return added.manifest;
  }, emptyManifest(script)), table);
  const guessed = speechLegs(partly)[2];
  if (guessed === undefined || guessed.content.alignment !== null) throw new Error("fixture: unit 2 should be a guess");
  const gapped = positionAt(speechLegs(partly), guessed.startMs + guessed.ms + 100);
  assert("a time inside an unmeasured leg seeks its start, as a mark there resolves to it; a time in the gap after it seeks the next unit's start", positionAt(speechLegs(partly), guessed.startMs + guessed.ms / 2).offsetMs === 0 && gapped.unitIndex === 3 && gapped.offsetMs === 0);
}

console.log("stateOf: the position in the conversation's time");
{
  const view = (player: NeuralView["player"], manifest: Manifest = emptyManifest(script)): NeuralView => {
    const timeline = timelineOfScript(manifest, table);
    return { player, manifest, holdings: script.map(() => ({ kind: "absent" })), timeline, units: speechLegs(timeline) };
  };
  assert("idle is idle", describe(stateOf(view({ kind: "idle" }))) === "idle");
  const unmeasured = view({ kind: "speaking", at: { unitIndex: 1, offsetMs: 0 }, flow: "waiting" });
  assert("a unit with no record yet is at its estimated leg's start", describe(stateOf(unmeasured)) === `speaking@${Math.round(timeAt(unmeasured.timeline, { utterance: 0, char: 21 }))}`);
  const third = view({ kind: "paused", at: { unitIndex: 3, offsetMs: 0 } });
  assert("the second turn's unit is past the gap: paused at its leg's start", describe(stateOf(third)) === `paused@${Math.round(timeAt(third.timeline, { utterance: 2, char: 0 }))}`);
  throws("a position past the script is a bug, not a time", () => stateOf(view({ kind: "paused", at: { unitIndex: 9, offsetMs: 0 } })));
  // The state carries the leg outright: a time alone, put back to the timeline, names the
  // neighbour once a unit streams past its guessed length.
  const overrun = view({ kind: "speaking", at: { unitIndex: 1, offsetMs: (unmeasured.units[1]?.ms ?? 0) + 400 }, flow: "audio" });
  const streaming = stateOf(overrun);
  assert("a unit streaming past its guess holds the clock at its leg's end and is still its own leg: the spot in it is its own segment, which the time alone would not paint", streaming.kind === "speaking" && streaming.leg === overrun.units[1] && streaming.atMs === streaming.leg.startMs + streaming.leg.ms && spotIn(streaming.leg, streaming.atMs).segment.charStart === 21 && JSON.stringify(spotAt(overrun.timeline, streaming.atMs)) !== JSON.stringify(spotIn(streaming.leg, streaming.atMs)));

  // Unit 0 recorded with word times ("First", "sentence", "here." at 0, 100, 200 ms):
  // the time is the offset itself, and the spot under it claims the word.
  const timed = addUnit(emptyManifest(script), 0, {
    durationMs: 300,
    alignment: { kind: "words", times: [{ startMs: 0, endMs: 100 }, { startMs: 100, endMs: 200 }, { startMs: 200, endMs: 300 }] },
  });
  if (timed.kind !== "added") throw new Error("fixture: the words report was rejected");
  const recorded = view({ kind: "speaking", at: { unitIndex: 0, offsetMs: 150 }, flow: "audio" }, timed.manifest);
  assert("a recorded unit reports its measured time, and the spot under it is the word under the clock", describe(stateOf(recorded)) === "speaking@150" && spotAt(recorded.timeline, 150)?.word?.charStart === 6);
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
  // Where a passage begins on the performer's clock right now.
  const startOf = (utterance: number, char = 0): number => timeAt(performer.view().timeline, { utterance, char });

  assert("built idle, nothing requested yet", describe(performer.state()) === "idle" && sent.length === 0);
  assert("the view carries the clock, with the gap before the second turn", performer.view().timeline.legs.some((leg) => leg.content.kind === "silence" && leg.ms === GAP_MS));

  performer.send({ kind: "seek", toMs: startOf(1) });
  assert("a seek to the second utterance's time starts its unit, waiting on synthesis", describe(performer.state()) === `speaking@${Math.round(startOf(1))}` && said() === "synthesize 2");
  assert("the change is reported with the clock attached", views.at(-1)?.timeline.legs.length === script.length + 1 && views.at(-1)?.player.kind === "speaking");

  performer.send({ kind: "pause" });
  assert("pausing holds the place", describe(performer.state()) === `paused@${Math.round(startOf(1))}`);
  performer.send({ kind: "seek", toMs: startOf(2) });
  assert("seeking while paused stays paused, at the new utterance past its gap; the unit in flight is cancelled for the new one", describe(performer.state()) === `paused@${Math.round(startOf(2))}` && said() === "synthesize 2,cancel 2,synthesize 3");
  emit({ kind: "cancelled", unitId: 2 });
  performer.send({ kind: "seek", toMs: startOf(0, 25) });
  assert("seeking to the first utterance's second sentence holds at that unit's start", describe(performer.state()) === `paused@${Math.round(startOf(0, 21))}` && said().endsWith("cancel 3,synthesize 1"));
  performer.send({ kind: "seek", toMs: startOf(2) - GAP_MS / 2 });
  assert("seeking into the gap before the second turn seeks the turn's unit at its start: the gap is the timeline's, the unit after it is the one wanted — the worker has not let go of it yet, so the request waits, and the unit behind, out of reach now, is withdrawn", describe(performer.state()) === `paused@${Math.round(startOf(2))}` && said().endsWith("cancel 3,synthesize 1,cancel 1"));
  emit({ kind: "cancelled", unitId: 3 });
  assert("the worker lets go: the turn's unit is asked for", said().endsWith("cancel 1,synthesize 3"));
  emit({ kind: "cancelled", unitId: 1 });
  performer.send({ kind: "seek", toMs: startOf(2) });
  assert("seeking to the turn's own start, past its gap: the place moves and the request stands", describe(performer.state()) === `paused@${Math.round(startOf(2))}` && said().endsWith("cancel 1,synthesize 3"));

  performer.send({ kind: "play" });
  emit({ kind: "audio", unitId: 3, frameIndex: 0, pcm: frame(3, 0) });
  emit({ kind: "done", unitId: 3, report: report(FRAME_S * 1000), elapsedMs: 5 });
  assert("audio for the unit: playing the last utterance, at its own start past the gap", describe(performer.state()) === `speaking@${Math.round(startOf(2))}`);
  device.advance(SCHEDULE_LEAD_S + FRAME_S + 0.01);
  assert("the last unit ends: idle", describe(performer.state()) === "idle");

  performer.send({ kind: "play" });
  assert("play from idle starts at the top", describe(performer.state()) === "speaking@0");

  const before = views.length;
  performer.dispose();
  assert("dispose stops the player and suspends the device; its owner closes it", performer.view().player.kind === "idle" && device.calls.at(-1) === "suspend");
  assert("a disposed performer reports nothing more", views.length === before);
}

console.log(process.exitCode === 1 ? "neural-performer-check: FAILED" : "neural-performer-check: ok");
