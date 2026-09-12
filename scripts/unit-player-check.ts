// The unit player, driven through play, pause, seek, unit swap, starvation and its relief,
// the end of the script and every delivery-contract violation against a stub playback
// device whose clock the check moves by hand (slopspot-read-along-q35.04v). Run:
// `tsx scripts/unit-player-check.ts`.
//
// [LAW:behavior-not-structure] Every assertion is about what the context would be told
// and what the page would read: which buffers start at which context time with which
// in-buffer offset, what `state()` reports at a clock reading, which events reach onState,
// which deliveries are refused and why. The device seam is stubbed at the type the player
// declares, so a different player over the same contract passes unchanged.
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
//   dispose   any                    -> idle; sources stopped; close()
//   drop      any other              -> forgotten; a later seek there waits for it
//   clock crosses a unit boundary    -> reported once, at the new unit (the scheduler's tick)
//   clock passes the schedule        -> flow waiting at the next needed sample, reported once
//   delivery while waiting           -> re-anchored at that sample, flow audio
//   last unit ends                   -> idle; suspend()
//   rate      speaking               -> re-anchored at the clock's sample, new sources at it
//   rate      idle | paused          -> held for the next play; nothing reported
//   rate      the rate already set   -> no-op

import { MODEL_PCM, SCHEDULE_LEAD_S, createUnitPlayer, extend, openSchedule, positionAt } from "../src/unitPlayer";
import type { DeviceFactory, PlayerState, UnitAudio } from "../src/unitPlayer";
import { FRAME_S, FS, SR, StubBuffer, StubDevice, StubSource, describe, frame } from "./playbackStub";

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
  const opened = openSchedule({ unit: 0, sample: 0 }, 1, MODEL_PCM);
  const empty = extend(opened, store, 3, MODEL_PCM);
  assert("an empty store schedules nothing and leaves the need unchanged", empty.cues.length === 0 && empty.schedule.need.unit === 0 && empty.schedule.cursor === 1);
  store.set(0, { frames: [frame(0, 0), frame(0, 1)], complete: true });
  store.set(1, { frames: [frame(1, 0)], complete: false });
  const crossed = extend(opened, store, 3, MODEL_PCM);
  assert("frames of two units are cued back to back across the boundary", crossed.cues.length === 3 && crossed.cues.every((c, i) => near(c.when, 1 + i * FRAME_S) && c.skip === 0));
  assert("the next unit's start is the previous unit's last sample end", crossed.schedule.starts.length === 2 && near(crossed.schedule.starts[1]?.time ?? NaN, 1 + 2 * FRAME_S));
  assert("the need stops at the open unit's next frame", crossed.schedule.need.unit === 1 && crossed.schedule.need.sample === FS);
  assert("position before the anchor is the position played from", positionAt(crossed.schedule, 0, MODEL_PCM).sample === 0);
  assert("position at the cursor is exactly the needed sample", positionAt(crossed.schedule, crossed.schedule.cursor, MODEL_PCM).unit === 1 && positionAt(crossed.schedule, crossed.schedule.cursor, MODEL_PCM).sample === FS);
  const mid = positionAt(crossed.schedule, 1 + 2 * FRAME_S + 0.01, MODEL_PCM);
  assert("position inside the second unit counts from its own start", mid.unit === 1 && mid.sample === 240);
  const midFrame = extend(openSchedule({ unit: 0, sample: 2400 }, 1, MODEL_PCM), store, 3, MODEL_PCM);
  assert("a mid-frame start cues the holding frame with the exact sample skip", midFrame.cues[0]?.skip === 480 && near(midFrame.cues[0]?.when ?? NaN, 1) && near(midFrame.cues[1]?.when ?? NaN, 1 + (FS - 480) / SR));
  const beyond = extend(openSchedule({ unit: 0, sample: 10 * FS }, 1, MODEL_PCM), store, 3, MODEL_PCM);
  assert("a start past a closed unit's end resolves to the next unit's first sample", beyond.cues[0]?.pcm === store.get(1)?.frames[0] && beyond.cues[0]?.skip === 0 && positionAt(beyond.schedule, 1, MODEL_PCM).unit === 1);
  const finished = extend(openSchedule({ unit: 1, sample: 0 }, 1, MODEL_PCM), new Map([[1, { frames: [frame(1, 0)], complete: true }]]), 2, MODEL_PCM);
  assert("the last unit's end leaves the need one past the end and no start for it", finished.schedule.need.unit === 2 && finished.schedule.starts.length === 1);
}

// ── the player ────────────────────────────────────────────────────────────────────────

const harness = (unitCount: number) => {
  const states: PlayerState[] = [];
  const player = createUnitPlayer({ Device: StubDevice, unitCount, onState: (state) => states.push(state) });
  const device = StubDevice.instances.at(-1);
  if (device === undefined) throw new Error("the player did not construct its device");
  return { player, device, states, reported: () => states.map(describe) };
};

console.log("player: play, gapless boundary, starvation, relief");
const main = harness(4);
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
  assert("position is read off the clock: 100 ms in after 0.10 s past the anchor", at.kind === "speaking" && at.at.unitIndex === 0 && near(at.at.offsetMs, 100));
  assert("a source ending mid-schedule reports nothing", states.length === 2);

  player.send({ kind: "complete", unit: 0 });
  player.send({ kind: "frame", unit: 1, frameIndex: 0, pcm: frame(1, 0) });
  const boundary = device.sources[3];
  assert("the next unit's first frame starts exactly where the last sample of the previous ends", near(boundary?.started?.when ?? NaN, first[2]?.endTime() ?? NaN));
  device.advance(0.15);
  const crossed = player.state();
  assert("past the boundary the position counts in the new unit", crossed.kind === "speaking" && crossed.at.unitIndex === 1 && near(crossed.at.offsetMs, 10));
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
  const fast = extend(openSchedule({ unit: 0, sample: 0 }, 1, MODEL_PCM, RATE), store, 2, MODEL_PCM);
  assert("a frame at 1.25x occupies four fifths of the context time it would at 1x", near(fast.cues[1]?.when ?? NaN, 1 + FRAME_S / RATE));
  assert("and the unit that follows begins that much sooner", near(fast.schedule.starts[1]?.time ?? NaN, 1 + (2 * FRAME_S) / RATE));
  const at = positionAt(fast.schedule, 1 + FRAME_S / RATE, MODEL_PCM);
  assert("the position at a context time is the sample the ear is on, not the sample a 1x clock would be", at.unit === 0 && at.sample === FS);
  assert("the round trip holds at the boundary: the cursor is the second unit's first sample", positionAt(fast.schedule, fast.schedule.starts[1]?.time ?? NaN, MODEL_PCM).unit === 1);
  assert("a schedule opened without a rate is the ordinary one", openSchedule({ unit: 0, sample: 0 }, 1, MODEL_PCM).rate === 1);
}

console.log("player: speed re-anchors where the ear is, and outlives every unit");
{
  const { player, device, states, reported } = harness(2);
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
    before.kind === "speaking" && after.kind === "speaking" && after.at.unitIndex === before.at.unitIndex && near(after.at.offsetMs, before.at.offsetMs, 1) && states.length === reportsBefore + 1,
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
  assert("the clock crosses into the second unit at the new speed", crossed.kind === "speaking" && crossed.at.unitIndex === 1 && reported().at(-1)?.startsWith("speaking/audio@1") === true);
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
  player.send({ kind: "seek", to: { unitIndex: 0, offsetMs: 100 } });
  const fresh = device.sources.slice(before);
  assert("seek into buffered audio schedules at once: the holding frame with its skip, the rest back to back into the next unit", fresh.length === 4 && near(fresh[0]?.started?.offset ?? NaN, 480 / SR) && contiguous(fresh) && fresh[2]?.buffer instanceof StubBuffer && fresh[2].buffer.data[0] === 101);
  assert("the previous schedule's source was stopped; position reads the target", device.live().length === 4 && describe(player.state()) === "speaking/audio@0:100.000");
  assert("a seek is a discontinuity: reported", states.length === 8);
  device.advance(0.1);
  const moved = player.state();
  assert("position runs on from the target", moved.kind === "speaking" && near(moved.at.offsetMs, 150));

  player.send({ kind: "seek", to: { unitIndex: 3, offsetMs: 0 } });
  assert("seek into an undelivered unit: nothing scheduled, waiting there — the request the scheduler answers", device.live().length === 0 && describe(player.state()) === "speaking/waiting@3:0.000");

  player.send({ kind: "seek", to: { unitIndex: 0, offsetMs: 5000 } });
  assert("seek past a closed unit's end plays the next unit from its first sample", describe(player.state()) === "speaking/audio@1:0.000" && device.sources.at(-2)?.buffer instanceof StubBuffer && (device.sources.at(-2)?.buffer as StubBuffer).data[0] === 101);

  player.send({ kind: "pause" });
  const resumes = device.calls.filter((c) => c === "resume").length;
  player.send({ kind: "seek", to: { unitIndex: 2, offsetMs: 0 } });
  assert("seek while paused moves the held position and starts nothing", describe(player.state()) === "paused@2:0.000" && device.live().length === 0 && device.calls.filter((c) => c === "resume").length === resumes);
  const held = main.states.length;
  player.send({ kind: "seek", to: { unitIndex: 2, offsetMs: 0 } });
  assert("seek while paused to the held position reports nothing", describe(player.state()) === "paused@2:0.000" && main.states.length === held);

  throws("seek to a unit past the script", () => player.send({ kind: "seek", to: { unitIndex: 4, offsetMs: 0 } }));
  throws("seek to a negative offset", () => player.send({ kind: "seek", to: { unitIndex: 0, offsetMs: -1 } }));
  throws("seek to a fractional unit", () => player.send({ kind: "seek", to: { unitIndex: 0.5, offsetMs: 0 } }));
}

console.log("player: drop and the delivery contract");
{
  const { player, device } = main;
  player.send({ kind: "play" });
  assert("resuming at an undelivered unit waits there", describe(player.state()) === "speaking/waiting@2:0.000");
  throws("complete of a unit with no frames", () => player.send({ kind: "complete", unit: 2 }));
  throws("drop of the unit being played", () => player.send({ kind: "drop", unit: 2 }));
  player.send({ kind: "drop", unit: 0 });
  player.send({ kind: "seek", to: { unitIndex: 0, offsetMs: 0 } });
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
  const { player, device, states, reported } = harness(2);
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
  assert("inside the last unit the position is in it", lastUnit.kind === "speaking" && lastUnit.at.unitIndex === 1 && near(lastUnit.at.offsetMs, 10));
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
  player.send({ kind: "seek", to: { unitIndex: 1, offsetMs: 5000 } });
  assert("seek past the end of the last unit finishes at once: idle, context suspended", player.state().kind === "idle" && device.calls.at(-1) === "suspend");
}
{
  const { player, device, states } = harness(0);
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

console.log("player: dispose");
{
  const { player, device, states } = harness(1);
  player.send({ kind: "frame", unit: 0, frameIndex: 0, pcm: frame(0, 0) });
  player.send({ kind: "play" });
  const count = states.length;
  player.dispose();
  assert("dispose while speaking: stopped and reported, the source silenced, the device suspended then closed", player.state().kind === "idle" && states.length === count + 1 && device.live().length === 0 && device.calls.slice(-2).join() === "suspend,close");
}

console.log(process.exitCode === 1 ? "unit-player-check: FAILED" : "unit-player-check: ok");
