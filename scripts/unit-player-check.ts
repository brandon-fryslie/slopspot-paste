// The unit player, driven through play, pause, seek, unit swap, starvation and its relief,
// the end of the script, the gap between speakers and every delivery-contract violation
// against a stub playback device whose clock the check moves by hand
// (slopspot-read-along-q35.04v, slopspot-read-along-a35.1ni). Run:
// `tsx scripts/unit-player-check.ts`.
//
// [LAW:behavior-not-structure] Every assertion is about what the context would be told
// and what the page would read: which buffers start at which context time with which
// in-buffer offset, what `state()` reports at a clock reading, which events reach onState,
// which deliveries are refused and why. The device seam is stubbed at the type the player
// declares, so a different player over the same contract passes unchanged. The layouts
// are the timeline's own (`layoutOf`), never hand-built: what the clock lays is what the
// player plays.
//
// ─── ACCEPT TABLE (event × state) ───────────────────────────────────────────────
//   play      idle                   -> speaking from (0,0); resume()
//   play      paused                 -> speaking from the held sample, mid-frame offset exact
//   play      speaking               -> no-op, nothing reported
//   pause     speaking               -> paused at the clock's sample; sources stopped; suspend()
//   pause     idle | paused          -> no-op
//   stop      any but idle           -> idle; sources stopped; suspend()
//   seek      idle | speaking        -> speaking from the target; buffered samples play at once
//   seek      paused                 -> paused at the target, nothing scheduled
//   seek      past a closed unit     -> the next unit's first sample
//   seek      out of range           -> RangeError
//   frame     in order, full length  -> stored; scheduled at the cursor if speaking
//   frame     wrong length | order | after complete | unknown unit -> RangeError
//   complete  once, after a frame    -> unit closed; the next unit begins at its last sample end
//   complete  with no frames         -> RangeError
//   complete  twice                  -> RangeError
//   drop      the unit being played  -> RangeError
//   dispose   any                    -> idle; sources stopped; suspend()
//   drop      any other              -> forgotten; a later seek there waits for it
//   clock crosses a unit boundary    -> reported once, at the new unit (the scheduler's tick)
//   clock passes the schedule        -> flow waiting at the next needed sample, reported once
//   delivery while waiting           -> re-anchored at that sample, flow audio
//   last unit ends                   -> idle; suspend()
//   rate      speaking               -> re-anchored at the clock's sample, new sources at it
//   rate      idle | paused          -> held for the next play; nothing reported
//   rate      the rate already set   -> no-op
//   a silence slot                -> cued as one silent frame of its length at the previous slot's end
//   speech after a gap            -> starts at the gap's end, never earlier
//   the gap ends, audio not here  -> waiting at the next slot's first sample: the gap lengthens
//   audio arrives late            -> starts then, at the clock; nothing shortens a gap
//   position inside a gap         -> that silence segment and the offset into it, of no unit
//   pause | seek | rate in a gap  -> the place in the gap is kept
//   seek to a gap's end           -> the next slot's first sample
//   layout not the timeline's     -> RangeError at construction

import { GAP_MS, layoutOf, type Slot } from "../src/timeline";
import { MODEL_PCM, SCHEDULE_LEAD_S, createUnitPlayer, extend, openDevice, openSchedule, positionAt, silenceSamples } from "../src/unitPlayer";
import type { DeviceFactory, PlayerState, UnitAudio } from "../src/unitPlayer";
import { FRAME_S, FS, SR, StubBuffer, StubDevice, StubSource, describe, frame } from "./playbackStub";

// A layout of `n` units on one turn: no gap anywhere, so a segment is its unit.
const speech = (n: number): ReadonlyArray<Slot> => layoutOf(Array.from({ length: n }, () => "a"));

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const throws = (label: string, fn: () => void): void => {
  try {
    fn();
    assert(`${label} (no throw)`, false);
  } catch (error) {
    assert(`${label}: ${error instanceof RangeError ? "RangeError" : String(error)}`, error instanceof RangeError);
  }
};

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

// The real AudioContext must fit the seam the player declares; this line is the proof the
// page's wiring will rest on, checked here where the DOM lib is present.
type RealDeviceFits = typeof AudioContext extends DeviceFactory ? true : never;
const realDeviceFits: RealDeviceFits = true;
assert("typeof AudioContext satisfies DeviceFactory", realDeviceFits);

// The cursor is accumulated as (frameSamples - skip) / sampleRate and the stub's end time
// as length / sampleRate - offset: the same quantity by two float formulas, compared to
// well under a sample.
const contiguous = (sources: ReadonlyArray<StubSource>): boolean =>
  sources.every((s, i) => i === 0 || near(s.started?.when ?? NaN, sources[i - 1]?.endTime() ?? NaN));

// ── the pure schedule ─────────────────────────────────────────────────────────────────

console.log("schedule: pure planning");
{
  const store = new Map<number, UnitAudio>();
  const opened = openSchedule({ slot: 0, sample: 0 }, 1, MODEL_PCM);
  const empty = extend(opened, store, speech(3), MODEL_PCM);
  assert("an empty store schedules nothing and leaves the need unchanged", empty.cues.length === 0 && empty.schedule.need.slot === 0 && empty.schedule.cursor === 1);
  store.set(0, { frames: [frame(0, 0), frame(0, 1)], complete: true });
  store.set(1, { frames: [frame(1, 0)], complete: false });
  const crossed = extend(opened, store, speech(3), MODEL_PCM);
  assert("frames of two units are cued back to back across the boundary", crossed.cues.length === 3 && crossed.cues.every((c, i) => near(c.when, 1 + i * FRAME_S) && c.skip === 0));
  assert("the next unit's start is the previous unit's last sample end", crossed.schedule.starts.length === 2 && near(crossed.schedule.starts[1]?.time ?? NaN, 1 + 2 * FRAME_S));
  assert("the need stops at the open unit's next frame", crossed.schedule.need.slot === 1 && crossed.schedule.need.sample === FS);
  assert("position before the anchor is the position played from", positionAt(crossed.schedule, 0, MODEL_PCM).sample === 0);
  assert("position at the cursor is exactly the needed sample", positionAt(crossed.schedule, crossed.schedule.cursor, MODEL_PCM).slot === 1 && positionAt(crossed.schedule, crossed.schedule.cursor, MODEL_PCM).sample === FS);
  const mid = positionAt(crossed.schedule, 1 + 2 * FRAME_S + 0.01, MODEL_PCM);
  assert("position inside the second unit counts from its own start", mid.slot === 1 && mid.sample === 240);
  const midFrame = extend(openSchedule({ slot: 0, sample: 2400 }, 1, MODEL_PCM), store, speech(3), MODEL_PCM);
  assert("a mid-frame start cues the holding frame with the exact sample skip", midFrame.cues[0]?.skip === 480 && near(midFrame.cues[0]?.when ?? NaN, 1) && near(midFrame.cues[1]?.when ?? NaN, 1 + (FS - 480) / SR));
  const beyond = extend(openSchedule({ slot: 0, sample: 10 * FS }, 1, MODEL_PCM), store, speech(3), MODEL_PCM);
  assert("a start past a closed unit's end resolves to the next unit's first sample", beyond.cues[0]?.pcm === store.get(1)?.frames[0] && beyond.cues[0]?.skip === 0 && positionAt(beyond.schedule, 1, MODEL_PCM).slot === 1);
  const finished = extend(openSchedule({ slot: 1, sample: 0 }, 1, MODEL_PCM), new Map([[1, { frames: [frame(1, 0)], complete: true }]]), speech(2), MODEL_PCM);
  assert("the last unit's end leaves the need one past the end and no start for it", finished.schedule.need.slot === 2 && finished.schedule.starts.length === 1);
}

// ── the player ────────────────────────────────────────────────────────────────────────

const harness = (layout: ReadonlyArray<Slot>) => {
  const states: PlayerState[] = [];
  const player = createUnitPlayer({ device: openDevice(StubDevice), layout, onState: (state) => states.push(state) });
  const device = StubDevice.instances.at(-1);
  if (device === undefined) throw new Error("the player did not construct its device");
  return { player, device, states, reported: () => states.map(describe) };
};

console.log("player: play, gapless boundary, starvation, relief");
const main = harness(speech(4));
{
  const { player, device, states } = main;
  assert("the device is constructed at the PCM's sample rate", device.sampleRate === SR);
  assert("fresh: idle, nothing asked of the device", player.state().kind === "idle" && device.calls.length === 0);

  player.send({ kind: "play" });
  assert("play with nothing delivered: waiting at (0, 0), resume() called", describe(player.state()) === "speaking/waiting@0:0.000" && device.calls.join() === "resume" && device.sources.length === 0);

  player.send({ kind: "frame", unit: 0, frameIndex: 0, pcm: frame(0, 0) });
  player.send({ kind: "frame", unit: 0, frameIndex: 1, pcm: frame(0, 1) });
  player.send({ kind: "frame", unit: 0, frameIndex: 2, pcm: frame(0, 2) });
  const first = device.sources;
  assert("three frames: three sources, lead ahead of the clock, back to back, no in-buffer offset", first.length === 3 && near(first[0]?.started?.when ?? NaN, SCHEDULE_LEAD_S) && contiguous(first) && first.every((s) => s.started?.offset === 0));
  assert("each buffer carries its frame's samples and is connected to the destination", first.every((s, i) => s.buffer instanceof StubBuffer && s.buffer.data[0] === i + 1 && s.buffer.length === FS && s.connected === device.destination));
  assert("flow is audio, position before the anchor is (0, 0)", describe(player.state()) === "speaking/audio@0:0.000");
  assert("waiting -> audio was reported once, nothing for the later frames", states.length === 2);

  device.advance(0.15);
  const at = player.state();
  assert("position is read off the clock: 100 ms in after 0.10 s past the anchor", at.kind === "speaking" && at.at.segment === 0 && near(at.at.offsetMs, 100));
  assert("a source ending mid-schedule reports nothing", states.length === 2);

  player.send({ kind: "complete", unit: 0 });
  player.send({ kind: "frame", unit: 1, frameIndex: 0, pcm: frame(1, 0) });
  const boundary = device.sources[3];
  assert("the next unit's first frame starts exactly where the last sample of the previous ends", near(boundary?.started?.when ?? NaN, first[2]?.endTime() ?? NaN));
  device.advance(0.15);
  const crossed = player.state();
  assert("past the boundary the position counts in the new unit", crossed.kind === "speaking" && crossed.at.segment === 1 && near(crossed.at.offsetMs, 10));
  assert("crossing the boundary is reported once, at the new unit", states.length === 3 && describe(states[2] ?? { kind: "idle" }) === "speaking/audio@1:10.000");

  device.advance(0.2);
  assert("the clock passing the schedule: every source ended, flow waiting at the next needed sample (1, 80 ms)", device.live().length === 0 && describe(player.state()) === "speaking/waiting@1:80.000");
  assert("starvation reported exactly once", states.length === 4 && describe(states[3] ?? { kind: "idle" }) === "speaking/waiting@1:80.000");

  player.send({ kind: "frame", unit: 1, frameIndex: 1, pcm: frame(1, 1) });
  const relief = device.sources[4];
  assert("relief re-anchors at the clock plus the lead and plays the needed frame whole", near(relief?.started?.when ?? NaN, device.currentTime + SCHEDULE_LEAD_S) && relief?.started?.offset === 0 && relief?.buffer instanceof StubBuffer && relief.buffer.data[0] === 102);
  assert("flow audio at (1, 80 ms), reported", describe(player.state()) === "speaking/audio@1:80.000" && states.length === 5);
  device.advance(0.06);
  const continued = player.state();
  assert("position continues from the relieved sample", continued.kind === "speaking" && near(continued.at.offsetMs, 90));
}

// ── speed ─────────────────────────────────────────────────────────────────────────────

console.log("schedule: a rate is context seconds per sample, both ways");
{
  const store = new Map<number, UnitAudio>([
    [0, { frames: [frame(0, 0), frame(0, 1)], complete: true }],
    [1, { frames: [frame(1, 0)], complete: true }],
  ]);
  const RATE = 1.25;
  const fast = extend(openSchedule({ slot: 0, sample: 0 }, 1, MODEL_PCM, RATE), store, speech(2), MODEL_PCM);
  assert("a frame at 1.25x occupies four fifths of the context time it would at 1x", near(fast.cues[1]?.when ?? NaN, 1 + FRAME_S / RATE));
  assert("and the unit that follows begins that much sooner", near(fast.schedule.starts[1]?.time ?? NaN, 1 + (2 * FRAME_S) / RATE));
  const at = positionAt(fast.schedule, 1 + FRAME_S / RATE, MODEL_PCM);
  assert("the position at a context time is the sample the ear is on, not the sample a 1x clock would be", at.slot === 0 && at.sample === FS);
  assert("the round trip holds at the boundary: the cursor is the second unit's first sample", positionAt(fast.schedule, fast.schedule.starts[1]?.time ?? NaN, MODEL_PCM).slot === 1);
  assert("a schedule opened without a rate is the ordinary one", openSchedule({ slot: 0, sample: 0 }, 1, MODEL_PCM).rate === 1);
}

console.log("player: speed re-anchors where the ear is, and outlives every unit");
{
  const { player, device, states, reported } = harness(speech(2));
  player.send({ kind: "frame", unit: 0, frameIndex: 0, pcm: frame(0, 0) });
  player.send({ kind: "frame", unit: 0, frameIndex: 1, pcm: frame(0, 1) });
  player.send({ kind: "complete", unit: 0 });
  player.send({ kind: "frame", unit: 1, frameIndex: 0, pcm: frame(1, 0) });
  player.send({ kind: "complete", unit: 1 });
  player.send({ kind: "play" });
  assert("every source of the first schedule plays at 1x", device.live().every((source) => source.playbackRate.value === 1));

  device.advance(SCHEDULE_LEAD_S + FRAME_S / 2);
  const before = player.state();
  const reportsBefore = states.length;
  player.send({ kind: "rate", to: 2 });
  const after = player.state();
  assert(
    "the speed change keeps the place: the same unit, the same millisecond, reported once",
    before.kind === "speaking" && after.kind === "speaking" && after.at.segment === before.at.segment && near(after.at.offsetMs, before.at.offsetMs, 1) && states.length === reportsBefore + 1,
  );
  assert("the sources now holding the audio were started at the new speed", device.live().length > 0 && device.live().every((source) => source.playbackRate.value === 2));
  assert("and they are still contiguous, so the boundary stays gapless at speed", contiguous(device.live()));

  const liveBefore = device.live().length;
  player.send({ kind: "rate", to: 2 });
  assert("the same speed again changes nothing: no re-anchor, no report", device.live().length === liveBefore && states.length === reportsBefore + 1);

  // Across the boundary: the unit that follows is played at the speed the reader chose,
  // which nobody re-sends — the player's own, outliving each schedule.
  // Half of the first unit's two frames was heard before the change, so one and a half
  // frames remain — at double speed, three quarters of a frame's worth of context time,
  // plus the lead the re-anchored schedule starts after.
  device.advance(SCHEDULE_LEAD_S + (1.5 * FRAME_S) / 2 + 0.005);
  const crossed = player.state();
  assert("the clock crosses into the second unit at the new speed", crossed.kind === "speaking" && crossed.at.segment === 1 && reported().at(-1)?.startsWith("speaking/audio@1") === true);
  assert("its sources carry the speed too", device.sources.filter((source) => !source.stopped).every((source) => source.playbackRate.value === 2));

  player.send({ kind: "pause" });
  player.send({ kind: "rate", to: 0.75 });
  const held = player.state();
  assert("a speed change while paused moves nothing and is not reported", held.kind === "paused" && near(held.at.offsetMs, crossed.kind === "speaking" ? crossed.at.offsetMs : NaN, 20));
  player.send({ kind: "play" });
  assert("the resume plays from the held sample at the speed chosen while paused", device.live().every((source) => source.playbackRate.value === 0.75));
  player.dispose();
}

console.log("player: pause holds a sample, resume is sample-accurate");
{
  const { player, device, states } = main;
  const calls = device.calls.length;
  player.send({ kind: "pause" });
  assert("pause: paused at the clock's sample, the live source stopped, suspend() called", describe(player.state()) === "paused@1:90.000" && device.live().length === 0 && device.calls.at(-1) === "suspend" && device.calls.length === calls + 1);
  device.advance(1);
  assert("the held position does not follow the clock; the stopped source's late ended reports nothing", describe(player.state()) === "paused@1:90.000" && states.length === 6);
  player.send({ kind: "pause" });
  assert("pause while paused: no-op", states.length === 6);

  player.send({ kind: "play" });
  const resumed = device.sources.at(-1);
  assert("resume plays the frame holding sample 2160 with a 240-sample offset at the lead", near(resumed?.started?.when ?? NaN, device.currentTime + SCHEDULE_LEAD_S) && near(resumed?.started?.offset ?? NaN, 240 / SR) && resumed?.buffer instanceof StubBuffer && resumed.buffer.data[0] === 102);
  assert("speaking again at (1, 90 ms), resume() called", describe(player.state()) === "speaking/audio@1:90.000" && device.calls.at(-1) === "resume");
  player.send({ kind: "play" });
  assert("play while speaking: no-op", states.length === 7 && device.sources.length === 6);
}

console.log("player: seek");
{
  const { player, device, states } = main;
  const before = device.sources.length;
  player.send({ kind: "seek", to: { segment: 0, offsetMs: 100 } });
  const fresh = device.sources.slice(before);
  assert("seek into buffered audio schedules at once: the holding frame with its skip, the rest back to back into the next unit", fresh.length === 4 && near(fresh[0]?.started?.offset ?? NaN, 480 / SR) && contiguous(fresh) && fresh[2]?.buffer instanceof StubBuffer && fresh[2].buffer.data[0] === 101);
  assert("the previous schedule's source was stopped; position reads the target", device.live().length === 4 && describe(player.state()) === "speaking/audio@0:100.000");
  assert("a seek is a discontinuity: reported", states.length === 8);
  device.advance(0.1);
  const moved = player.state();
  assert("position runs on from the target", moved.kind === "speaking" && near(moved.at.offsetMs, 150));

  player.send({ kind: "seek", to: { segment: 3, offsetMs: 0 } });
  assert("seek into an undelivered unit: nothing scheduled, waiting there — the request the scheduler answers", device.live().length === 0 && describe(player.state()) === "speaking/waiting@3:0.000");

  player.send({ kind: "seek", to: { segment: 0, offsetMs: 5000 } });
  assert("seek past a closed unit's end plays the next unit from its first sample", describe(player.state()) === "speaking/audio@1:0.000" && device.sources.at(-2)?.buffer instanceof StubBuffer && (device.sources.at(-2)?.buffer as StubBuffer).data[0] === 101);

  player.send({ kind: "pause" });
  const resumes = device.calls.filter((c) => c === "resume").length;
  player.send({ kind: "seek", to: { segment: 2, offsetMs: 0 } });
  assert("seek while paused moves the held position and starts nothing", describe(player.state()) === "paused@2:0.000" && device.live().length === 0 && device.calls.filter((c) => c === "resume").length === resumes);
  const held = main.states.length;
  player.send({ kind: "seek", to: { segment: 2, offsetMs: 0 } });
  assert("seek while paused to the held position reports nothing", describe(player.state()) === "paused@2:0.000" && main.states.length === held);

  throws("seek to a segment past the layout", () => player.send({ kind: "seek", to: { segment: 4, offsetMs: 0 } }));
  throws("seek to a negative offset", () => player.send({ kind: "seek", to: { segment: 0, offsetMs: -1 } }));
  throws("seek to a fractional segment", () => player.send({ kind: "seek", to: { segment: 0.5, offsetMs: 0 } }));
}

console.log("player: drop and the delivery contract");
{
  const { player, device } = main;
  player.send({ kind: "play" });
  assert("resuming at an undelivered unit waits there", describe(player.state()) === "speaking/waiting@2:0.000");
  throws("complete of a unit with no frames", () => player.send({ kind: "complete", unit: 2 }));
  throws("drop of the unit being played", () => player.send({ kind: "drop", unit: 2 }));
  player.send({ kind: "drop", unit: 0 });
  player.send({ kind: "seek", to: { segment: 0, offsetMs: 0 } });
  assert("a dropped unit is waited for again", describe(player.state()) === "speaking/waiting@0:0.000" && device.live().length === 0);
  player.send({ kind: "frame", unit: 0, frameIndex: 0, pcm: frame(0, 0) });
  assert("a dropped unit accepts frame 0 afresh and plays", describe(player.state()) === "speaking/audio@0:0.000");

  throws("a frame of the wrong length", () => player.send({ kind: "frame", unit: 0, frameIndex: 1, pcm: new Float32Array(new ArrayBuffer(4 * (FS - 1))) }));
  throws("a frame out of order", () => player.send({ kind: "frame", unit: 0, frameIndex: 5, pcm: frame(0, 5) }));
  throws("a frame for a unit past the script", () => player.send({ kind: "frame", unit: 4, frameIndex: 0, pcm: frame(4, 0) }));
  player.send({ kind: "complete", unit: 1 });
  throws("a frame after complete", () => player.send({ kind: "frame", unit: 1, frameIndex: 2, pcm: frame(1, 2) }));
  throws("complete twice", () => player.send({ kind: "complete", unit: 1 }));
  throws("complete for a unit past the script", () => player.send({ kind: "complete", unit: 4 }));
  throws("drop of a unit past the script", () => player.send({ kind: "drop", unit: 4 }));
  assert("a refused delivery leaves the player where it was", describe(player.state()) === "speaking/audio@0:0.000");

  // The unit the player is paused on may be dropped: resuming waits there for the
  // scheduler to deliver it again, never resumes audio the player no longer holds.
  player.send({ kind: "pause" });
  assert("paused on unit 0", describe(player.state()) === "paused@0:0.000");
  player.send({ kind: "drop", unit: 0 });
  player.send({ kind: "play" });
  assert("resuming on a dropped unit waits at the held position", describe(player.state()) === "speaking/waiting@0:0.000" && device.live().length === 0);
  player.send({ kind: "frame", unit: 0, frameIndex: 0, pcm: frame(0, 0) });
  assert("its redelivery resumes the audio there", describe(player.state()) === "speaking/audio@0:0.000");
}

console.log("player: stop, and the end of the script");
{
  const { player, device, states } = main;
  const count = states.length;
  player.send({ kind: "stop" });
  assert("stop: idle, sources stopped, suspend() called, reported", player.state().kind === "idle" && device.live().length === 0 && device.calls.at(-1) === "suspend" && states.length === count + 1);
  player.send({ kind: "stop" });
  assert("stop while idle: no-op", states.length === count + 1 && device.calls.at(-1) === "suspend");
  player.send({ kind: "play" });
  assert("play after stop starts from (0, 0)", describe(player.state()) === "speaking/audio@0:0.000");
}
{
  const { player, device, states, reported } = harness(speech(2));
  player.send({ kind: "frame", unit: 0, frameIndex: 0, pcm: frame(0, 0) });
  player.send({ kind: "frame", unit: 0, frameIndex: 1, pcm: frame(0, 1) });
  player.send({ kind: "complete", unit: 0 });
  player.send({ kind: "frame", unit: 1, frameIndex: 0, pcm: frame(1, 0) });
  player.send({ kind: "complete", unit: 1 });
  assert("deliveries while idle are stored and schedule nothing", device.sources.length === 0 && states.length === 0);
  player.send({ kind: "play" });
  assert("play over a fully delivered script cues every frame", device.sources.length === 3 && contiguous(device.sources) && describe(player.state()) === "speaking/audio@0:0.000");
  device.advance(SCHEDULE_LEAD_S + 2 * FRAME_S + 0.01);
  const lastUnit = player.state();
  assert("inside the last unit the position is in it", lastUnit.kind === "speaking" && lastUnit.at.segment === 1 && near(lastUnit.at.offsetMs, 10));
  const positions: number[] = [];
  for (let i = 0; i < 5; i++) {
    device.advance(0.005);
    const s = player.state();
    positions.push(s.kind === "speaking" ? s.at.offsetMs : NaN);
  }
  assert("position never regresses while flowing", positions.every((p, i) => i === 0 || p >= (positions[i - 1] ?? NaN)));
  device.advance(1);
  assert("after the last frame ends: idle, suspend() called", player.state().kind === "idle" && device.calls.at(-1) === "suspend");
  assert("the whole run reported audio, the boundary, then idle", reported().join(" ") === "speaking/audio@0:0.000 speaking/audio@1:10.000 idle");
  player.send({ kind: "seek", to: { segment: 1, offsetMs: 5000 } });
  assert("seek past the end of the last unit finishes at once: idle, context suspended", player.state().kind === "idle" && device.calls.at(-1) === "suspend");
}
{
  const { player, device, states } = harness(speech(0));
  player.send({ kind: "play" });
  assert("an empty script: play leaves the player idle and the context suspended, nothing reported", player.state().kind === "idle" && device.calls.at(-1) === "suspend" && states.length === 0);
}

console.log("player: the reported sequence");
assert(
  "every discontinuity and boundary was reported, in order, and nothing else",
  main.reported().join(" ") ===
    [
      "speaking/waiting@0:0.000",
      "speaking/audio@0:0.000",
      "speaking/audio@1:10.000",
      "speaking/waiting@1:80.000",
      "speaking/audio@1:80.000",
      "paused@1:90.000",
      "speaking/audio@1:90.000",
      "speaking/audio@0:100.000",
      "speaking/waiting@3:0.000",
      "speaking/audio@1:0.000",
      "paused@1:0.000",
      "paused@2:0.000",
      "speaking/waiting@2:0.000",
      "speaking/waiting@0:0.000",
      "speaking/audio@0:0.000",
      "paused@0:0.000",
      "speaking/waiting@0:0.000",
      "speaking/audio@0:0.000",
      "idle",
      "speaking/audio@0:0.000",
    ].join(" "),
);

const wholeSample = (state: PlayerState): boolean =>
  state.kind === "idle" || near((state.at.offsetMs * SR) / 1000, Math.round((state.at.offsetMs * SR) / 1000));
assert("every reported position lies on a whole sample", main.states.every(wholeSample));


// ── the gap between speakers ──────────────────────────────────────────────────────────

console.log("player: the gap is the timeline's own segment, played as one");
{
  // Two units on two turns: the layout is unit 0, a gap, unit 1.
  const layout = layoutOf(["a", "b"]);
  const GAP_S = GAP_MS / 1000;
  const gapSamples = silenceSamples({ kind: "silence", ms: GAP_MS }, MODEL_PCM);
  assert("the layout under test is speech, silence, speech", layout.map((slot) => slot.kind).join() === "speech,silence,speech");
  const { player, device, states, reported } = harness(layout);
  player.send({ kind: "frame", unit: 0, frameIndex: 0, pcm: frame(0, 0) });
  player.send({ kind: "frame", unit: 0, frameIndex: 1, pcm: frame(0, 1) });
  player.send({ kind: "complete", unit: 0 });
  player.send({ kind: "play" });
  const [first, second, gap] = device.sources;
  assert("unit 0's two frames and then the gap are cued: three sources, back to back", device.sources.length === 3 && contiguous(device.sources));
  assert("the gap is one silent frame of its whole length, at the previous slot's end", gap?.buffer instanceof StubBuffer && gap.buffer.length === gapSamples && gap.buffer.data.every((v) => v === 0) && near(gap.started?.when ?? NaN, second?.endTime() ?? NaN) && gap.started?.offset === 0);
  assert("unit 1, undelivered, is not cued: the schedule needs its first sample, past the gap", first !== undefined && describe(player.state()) === "speaking/audio@0:0.000");

  device.advance(SCHEDULE_LEAD_S + 2 * FRAME_S + 0.1);
  const inGap = player.state();
  assert("100 ms into the gap the position is the silence segment and the offset into it — no unit's", inGap.kind === "speaking" && inGap.at.segment === 1 && near(inGap.at.offsetMs, 100) && inGap.flow === "audio");
  assert("crossing into the gap was reported once, at the gap", reported().filter((r) => r.startsWith("speaking/audio@1:")).length === 1);

  // The gap ends and unit 1 is still not here: the schedule ran dry at the unit's first
  // sample, which is where the position holds until the audio arrives.
  device.advance(GAP_S);
  assert("at the gap's end with nothing delivered: waiting at unit 1's slot, its first sample", describe(player.state()) === "speaking/waiting@2:0.000" && device.live().length === 0);
  device.advance(0.3);
  assert("300 ms later, still there: the gap has lengthened by exactly the lateness", describe(player.state()) === "speaking/waiting@2:0.000");
  const gapEnd = gap?.endTime() ?? NaN;
  player.send({ kind: "frame", unit: 1, frameIndex: 0, pcm: frame(1, 0) });
  const late = device.sources.at(-1);
  assert("the late audio starts when it arrives, at the clock plus the lead — after the gap's scheduled end, never before it", near(late?.started?.when ?? NaN, device.currentTime + SCHEDULE_LEAD_S) && (late?.started?.when ?? NaN) > gapEnd && describe(player.state()) === "speaking/audio@2:0.000");

  // The unit whose frames the schedule is cueing as they arrive is untouchable, from its
  // own slot and from the gap before it alike.
  throws("the unit being cued cannot be dropped", () => player.send({ kind: "drop", unit: 1 }));
  player.send({ kind: "seek", to: { segment: 1, offsetMs: 0 } });
  throws("nor from inside the gap before it, where the schedule needs its next frame", () => player.send({ kind: "drop", unit: 1 }));
  player.send({ kind: "drop", unit: 0 });
  assert("the unit behind the gap can be dropped while the gap sounds", describe(player.state()) === "speaking/audio@1:0.000");
  player.send({ kind: "complete", unit: 1 });

  // Seek into the gap: the remainder of the silence is cued with the exact skip, and the
  // unit after it — delivered now — starts at the silence's end.
  const before = device.sources.length;
  player.send({ kind: "seek", to: { segment: 1, offsetMs: 200 } });
  const fresh = device.sources.slice(before);
  assert("seek 200 ms into the gap: the silence cued from that sample, then unit 1 at its end", fresh.length === 2 && near(fresh[0]?.started?.offset ?? NaN, 0.2) && fresh[0]?.buffer instanceof StubBuffer && fresh[0].buffer.length === gapSamples && near(fresh[1]?.started?.when ?? NaN, fresh[0]?.endTime() ?? NaN) && describe(player.state()) === "speaking/audio@1:200.000");
  assert("unit 1's audio begins exactly 300 ms of silence later, no earlier", near((fresh[1]?.started?.when ?? NaN) - (fresh[0]?.started?.when ?? NaN), GAP_S - 0.2));

  device.advance(SCHEDULE_LEAD_S + 0.05);
  player.send({ kind: "pause" });
  assert("pause inside the gap holds the place in the gap", describe(player.state()) === "paused@1:250.000" && device.live().length === 0);
  player.send({ kind: "play" });
  const resumed = device.sources.at(-2);
  assert("resume plays the rest of the gap from that sample, then the unit", describe(player.state()) === "speaking/audio@1:250.000" && near(resumed?.started?.offset ?? NaN, 0.25) && resumed?.buffer instanceof StubBuffer && resumed.buffer.length === gapSamples);

  const count = states.length;
  player.send({ kind: "rate", to: 2 });
  const sped = player.state();
  assert("a speed change inside the gap keeps the place in the gap and reports once", sped.kind === "speaking" && sped.at.segment === 1 && near(sped.at.offsetMs, 250, 1) && states.length === count + 1);
  const [fastGap, fastUnit] = device.live();
  assert("at 2x the rest of the gap takes half its time, and the unit follows at its end", fastGap?.playbackRate.value === 2 && near((fastUnit?.started?.when ?? NaN) - (fastGap?.started?.when ?? NaN), (GAP_S - 0.25) / 2) && fastUnit?.playbackRate.value === 2);
  player.send({ kind: "rate", to: 1 });

  player.send({ kind: "seek", to: { segment: 1, offsetMs: GAP_MS } });
  assert("a seek to the gap's very end is the next slot's first sample", describe(player.state()) === "speaking/audio@2:0.000" && device.live()[0]?.buffer instanceof StubBuffer && (device.live()[0]?.buffer as StubBuffer).data[0] === 101);
  throws("a seek to a segment past the layout", () => player.send({ kind: "seek", to: { segment: 3, offsetMs: 0 } }));

  player.send({ kind: "seek", to: { segment: 0, offsetMs: 0 } });
  assert("seeking back to the dropped unit waits there", describe(player.state()) === "speaking/waiting@0:0.000");
  player.dispose();
}

console.log("player: a layout that is not the timeline's is refused");
{
  const build = (layout: ReadonlyArray<Slot>): void => {
    createUnitPlayer({ device: openDevice(StubDevice), layout, onState: () => undefined });
  };
  throws("speech slots out of unit order", () => build([{ kind: "speech", span: 1 }, { kind: "speech", span: 0 }]));
  throws("a speech slot naming a unit twice", () => build([{ kind: "speech", span: 0 }, { kind: "speech", span: 0 }]));
  throws("a silence of no length", () => build([{ kind: "speech", span: 0 }, { kind: "silence", ms: 0 }, { kind: "speech", span: 1 }]));
  build(layoutOf(["a", "b", "b", "c"]));
  assert("the timeline's own layout is admitted", true);
}

console.log("player: dispose");
{
  const { player, device, states } = harness(speech(1));
  player.send({ kind: "frame", unit: 0, frameIndex: 0, pcm: frame(0, 0) });
  player.send({ kind: "play" });
  const count = states.length;
  player.dispose();
  assert("dispose while speaking: stopped and reported, the source silenced, the device suspended, not closed (its owner closes it)", player.state().kind === "idle" && states.length === count + 1 && device.live().length === 0 && device.calls.at(-1) === "suspend");
}

console.log(process.exitCode === 1 ? "unit-player-check: FAILED" : "unit-player-check: ok");
