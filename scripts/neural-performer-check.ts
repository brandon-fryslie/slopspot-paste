// The neural voice behind the performer seam: the utterance table at the door, seeks by a
// time on the conversation's clock, the position read back as one, and a seek into the
// timeline's gap between speakers landing in the gap (slopspot-read-along-a35.1,
// slopspot-read-along-a35.1ni). Run: `tsx scripts/neural-performer-check.ts`.
//
// [LAW:behavior-not-structure] What is asserted is the contract the panel drives: which
// segment a seek to a time starts and at what offset, what time the performer reports for
// a player position, and that a script that is not this page's is refused. The real
// scheduler and the real unit player run underneath, over the stub device and a stub port.

import { createNeuralPerformer, passages, segmentOffsetAt, stateOf, timeOf, utteranceTable, type NeuralView } from "../src/neuralPerformer";
import type { PerformerState } from "../src/performer";
import type { Utterance } from "../src/speech";
import { addUnit, emptyManifest, type Manifest, type UnitReport } from "../src/speechManifest";
import { prepareText, type SynthesisUnit } from "../src/speechScript";
import { DEFAULT_VOICES } from "../src/voiceChoice";
import type { SynthesisPort } from "../src/synthesisClient";
import type { FromWorker, ToWorker } from "../src/synthesisProtocol";
import { SCHEDULE_LEAD_S, openDevice } from "../src/unitPlayer";
import { GAP_MS, cursorAt, cursorIn, speechSegments, timeAt, timelineOfScript } from "../src/timeline";
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
const unit = (utterance: Utterance, start: number, end: number): SynthesisUnit => ({ utterance, start, end, ...prepareText(utterance.text.slice(start, end)) });
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

console.log("timeOf and segmentOffsetAt: the player's segment and offset against the conversation's clock, both ways");
{
  // Every unit measured at 1000 ms: the clock is 0–1000 unit 0 (segment 0), 1000–2000
  // unit 1 (segment 1), 2000–3000 unit 2 (segment 2), then the gap (segment 3), then
  // 3500–4500 unit 3 (segment 4).
  const measured = [0, 1, 2, 3].reduce((manifest: Manifest, index) => {
    const added = addUnit(manifest, index, { durationMs: 1000, alignment: { kind: "unit" } });
    if (added.kind !== "added") throw new Error(`fixture: unit ${index} was ${added.kind}`);
    return added.manifest;
  }, emptyManifest(script));
  const line = timelineOfScript(measured, table);
  assert("the fixture's clock is as described", line.totalMs === 4000 + GAP_MS && timeAt(line, { utterance: 2, char: 0 }) === 3000 + GAP_MS && line.segments[3]?.content.kind === "silence");
  assert("a segment's offset is its start plus the offset", timeOf(line, { segment: 1, offsetMs: 250 }) === 1250 && timeOf(line, { segment: 4, offsetMs: 0 }) === 3000 + GAP_MS);
  assert("an offset into the gap is a time inside the gap: the timeline's own, no unit's, and nothing is painted there", timeOf(line, { segment: 3, offsetMs: 200 }) === 3200 && cursorAt(line, 3200) === null);
  assert("an offset past the segment reads as its end: the clock never runs ahead of the timeline it is laid on", timeOf(line, { segment: 2, offsetMs: 1200 }) === 3000 && timeOf(line, { segment: 3, offsetMs: 900 }) === 3000 + GAP_MS);
  throws("a segment the timeline does not have is a player built over another layout", () => timeOf(line, { segment: 9, offsetMs: 0 }));
  const pos = (ms: number): string => {
    const p = segmentOffsetAt(line, ms);
    return `${p.segment}@${Math.round(p.offsetMs)}`;
  };
  assert("a time inside a unit is that unit's segment and the offset", pos(1250) === "1@250" && pos(0) === "0@0");
  assert("a time inside the gap is the gap and the offset into it — never the unit after it", pos(3200) === "3@200" && pos(3000) === "3@0" && pos(3499) === "3@499");
  assert("the gap's end is the next unit's start", pos(3000 + GAP_MS) === "4@0");
  assert("before the start is the first segment's start; past the end is the last unit's end", pos(-500) === "0@0" && pos(9000) === "4@1000");
  assert("the two are inverse over every segment, gap included", [0, 1, 2, 3, 4].every((segment) => [0, 333, 499].every((offsetMs) => near(segmentOffsetAt(line, timeOf(line, { segment, offsetMs })).offsetMs, offsetMs))));
  throws("a timeline with no segments has nothing to seek", () => segmentOffsetAt({ segments: [], totalMs: 0 }, 0));
  // Unit 2 unmeasured: a guess is not a place in audio nobody has heard.
  const partly = timelineOfScript([0, 1, 3].reduce((manifest: Manifest, index) => {
    const added = addUnit(manifest, index, { durationMs: 1000, alignment: { kind: "unit" } });
    if (added.kind !== "added") throw new Error(`fixture: unit ${index} was ${added.kind}`);
    return added.manifest;
  }, emptyManifest(script)), table);
  const guessed = speechSegments(partly)[2];
  if (guessed === undefined || guessed.content.alignment !== null) throw new Error("fixture: unit 2 should be a guess");
  const gapped = segmentOffsetAt(partly, guessed.startMs + guessed.ms + 100);
  assert("a time inside an unmeasured segment seeks its start, as a place there resolves to it; a time in the gap after it is 100 ms into the gap, since silence is never a guess", segmentOffsetAt(partly, guessed.startMs + guessed.ms / 2).offsetMs === 0 && gapped.segment === 3 && gapped.offsetMs === 100);
}

console.log("stateOf: the position in the conversation's time");
{
  const view = (player: NeuralView["player"], manifest: Manifest = emptyManifest(script)): NeuralView => {
    const timeline = timelineOfScript(manifest, table);
    return { player, manifest, holdings: script.map(() => ({ kind: "absent" })), settled: false, timeline, units: speechSegments(timeline) };
  };
  assert("idle is idle", describe(stateOf(view({ kind: "idle" }))) === "idle");
  const unmeasured = view({ kind: "speaking", at: { segment: 1, offsetMs: 0 }, flow: "waiting" });
  assert("a unit with no record yet is at its estimated segment's start", describe(stateOf(unmeasured)) === `speaking@${Math.round(timeAt(unmeasured.timeline, { utterance: 0, char: 21 }))}`);
  const third = view({ kind: "paused", at: { segment: 4, offsetMs: 0 } });
  assert("the second turn's unit is past the gap: paused at its segment's start", describe(stateOf(third)) === `paused@${Math.round(timeAt(third.timeline, { utterance: 2, char: 0 }))}`);
  const gap = view({ kind: "paused", at: { segment: 3, offsetMs: 120 } });
  const inGap = stateOf(gap);
  assert("paused in the gap: a time 120 ms into the silence segment, the segment itself silence, nothing to paint", inGap.kind === "paused" && inGap.segment.content.kind === "silence" && inGap.atMs === inGap.segment.startMs + 120 && cursorIn(inGap.segment, inGap.atMs) === null);
  throws("a position past the layout is a bug, not a time", () => stateOf(view({ kind: "paused", at: { segment: 9, offsetMs: 0 } })));
  // The state carries the segment outright: a time alone, put back to the timeline, names
  // the neighbour once a unit streams past its guessed length.
  const overrun = view({ kind: "speaking", at: { segment: 1, offsetMs: (unmeasured.units[1]?.ms ?? 0) + 400 }, flow: "audio" });
  const streaming = stateOf(overrun);
  assert("a unit streaming past its guess holds the clock at its segment's end and is still its own segment: the cursor in it is its own range, which the time alone would not paint", streaming.kind === "speaking" && streaming.segment === overrun.units[1] && streaming.atMs === streaming.segment.startMs + streaming.segment.ms && cursorIn(streaming.segment, streaming.atMs)?.range.charStart === 21 && JSON.stringify(cursorAt(overrun.timeline, streaming.atMs)) !== JSON.stringify(cursorIn(streaming.segment, streaming.atMs)));

  // Unit 0 recorded with word times ("First", "sentence", "here." at 0, 100, 200 ms):
  // the time is the offset itself, and the spot under it claims the word.
  const timed = addUnit(emptyManifest(script), 0, {
    durationMs: 300,
    alignment: { kind: "words", times: [{ startMs: 0, endMs: 100 }, { startMs: 100, endMs: 200 }, { startMs: 200, endMs: 300 }] },
  });
  if (timed.kind !== "added") throw new Error("fixture: the words report was rejected");
  const recorded = view({ kind: "speaking", at: { segment: 0, offsetMs: 150 }, flow: "audio" }, timed.manifest);
  assert("a recorded unit reports its measured time, and the cursor under it is the word under the clock", describe(stateOf(recorded)) === "speaking@150" && cursorAt(recorded.timeline, 150)?.word?.charStart === 6);
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
  assert("the view carries the clock, with the gap before the second turn", performer.view().timeline.segments.some((segment) => segment.content.kind === "silence" && segment.ms === GAP_MS));

  performer.send({ kind: "seek", toMs: startOf(1) });
  assert("a seek to the second utterance's time starts its unit, waiting on synthesis", describe(performer.state()) === `speaking@${Math.round(startOf(1))}` && said() === "synthesize 2");
  assert("the change is reported with the clock attached", views.at(-1)?.timeline.segments.length === script.length + 1 && views.at(-1)?.player.kind === "speaking");

  performer.send({ kind: "pause" });
  assert("pausing holds the place", describe(performer.state()) === `paused@${Math.round(startOf(1))}`);
  performer.send({ kind: "seek", toMs: startOf(2) });
  assert("seeking while paused stays paused, at the new utterance past its gap; the unit in flight is cancelled for the new one", describe(performer.state()) === `paused@${Math.round(startOf(2))}` && said() === "synthesize 2,cancel 2,synthesize 3");
  emit({ kind: "cancelled", unitId: 2 });
  performer.send({ kind: "seek", toMs: startOf(0, 25) });
  assert("seeking to the first utterance's second sentence holds at that unit's start", describe(performer.state()) === `paused@${Math.round(startOf(0, 21))}` && said().endsWith("cancel 3,synthesize 1"));
  performer.send({ kind: "seek", toMs: startOf(2) - GAP_MS / 2 });
  assert("seeking into the gap before the second turn lands in the gap: the place is a time inside the silence, and the unit the gap leads into is the one wanted — the worker has not let go of it yet, so the request waits, and the unit behind, out of reach now, is withdrawn", describe(performer.state()) === `paused@${Math.round(startOf(2) - GAP_MS / 2)}` && performer.state().kind === "paused" && said().endsWith("cancel 3,synthesize 1,cancel 1"));
  const held = performer.state();
  assert("the state's segment is the silence itself", held.kind === "paused" && held.segment.content.kind === "silence");
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
