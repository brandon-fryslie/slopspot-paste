// The scheduler, driven through every transition of its pure `step` with a stub position,
// then as a live driver over a stub synthesis port and the REAL unit player on the stub
// playback device — so the player's own delivery contract (frames in order, drop never the
// unit being cued) is enforced on the scheduler's commands by the code that owns it
// (slopspot-read-along-q35.wuv). Run: `tsx scripts/scheduler-check.ts`.
//
// [LAW:behavior-not-structure] Every assertion is about what the worker would be told and
// what the player would receive — which unit is requested, cancelled, dropped, in what
// order — and what the panel would read off the view. The pure core is driven as data, so a
// different planner honouring the same contract passes unchanged.
//
// ─── ACCEPT TABLE (event × state) ───────────────────────────────────────────────
//   idle                          -> nothing requested; everything held or in flight evicted
//   play, nothing held            -> synthesize the cursor unit, nothing else in flight
//   audio for a requested unit    -> frame to the player; state object unchanged
//   audio for cancelling          -> discarded
//   audio for absent | held       -> Error
//   done for requested            -> complete to the player; held; manifest record
//   done rejected by the manifest -> failed{rejection}, frames left in the player
//   done | failed for cancelling  -> absent (the cancel raced the terminal)
//   cancelled for cancelling      -> absent; re-requested when wanted
//   cancelled otherwise           -> Error
//   failed for requested          -> failed{reason}; its frames dropped unless it is the frontier
//   failed{duplicate-unit}        -> Error (a scheduler bug)
//   refused synthesize | cancel   -> Error; other refusals and the panel's messages ignored
//   held ahead reaches 3 units    -> no further request
//   held ahead reaches 30 s       -> no further request, even under 3 units
//   boundary crossed              -> the next unit requested; the unit 2 behind dropped
//   seek far ahead                -> held islands dropped, in-flight cancelled, target requested
//   seek back to an absent unit   -> in-flight (still in window) cancelled, target requested
//   the frontier                  -> never dropped or cancelled, even past the window
//   held run contiguous from cursor -> kept even past the window
//   cursor enters a failed unit   -> seek to the next unit, its frames dropped
//   cursor enters a failed last unit -> stop
//   paused                        -> same window as speaking
//   re-synthesis after a drop     -> the manifest record is replaced
//   driver: reports raised by its own commands are handled after them, in order
//   driver: dispose stops, cancels, drops, stops listening, and closes the device

import { KEEP_BEHIND, LOOKAHEAD, createScheduler, initialState, step } from "../src/scheduler";
import type { Command, Event, Holding, SchedulerState, SchedulerView } from "../src/scheduler";
import { wordsOf } from "../src/speechManifest";
import type { UnitReport } from "../src/speechManifest";
import type { Utterance } from "../src/speech";
import type { SynthesisUnit, VoiceMap } from "../src/speechScript";
import type { SynthesisPort } from "../src/synthesisClient";
import type { FromWorker, ToWorker } from "../src/synthesisProtocol";
import { SCHEDULE_LEAD_S, createUnitPlayer } from "../src/unitPlayer";
import type { PlayerState } from "../src/unitPlayer";
import { FRAME_S, StubDevice, describe, frame } from "./playbackStub";

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
    assert(`${label}: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error);
  }
};

// ── fixtures ──────────────────────────────────────────────────────────────────────────

const VOICES: VoiceMap = { user: "alba", assistant: "marius", system: "javert", narrator: "fantine" };

const unitOf = (index: number, text: string, voice: Utterance["voice"] = "assistant"): SynthesisUnit => ({
  utterance: { index, anchor: `t${index}`, voice, text },
  start: 0,
  end: text.length,
  text,
});
const scriptOf = (count: number): ReadonlyArray<SynthesisUnit> =>
  Array.from({ length: count }, (_, i) => unitOf(i, `Unit ${i} says hello.`, i % 2 === 0 ? "assistant" : "user"));

const report = (durationMs: number): UnitReport => ({ durationMs, alignment: { kind: "unit" } });

const idle: PlayerState = { kind: "idle" };
const speaking = (unitIndex: number, offsetMs = 0, flow: "audio" | "waiting" = "waiting"): PlayerState => ({
  kind: "speaking",
  at: { unitIndex, offsetMs },
  flow,
});
const paused = (unitIndex: number, offsetMs = 0): PlayerState => ({ kind: "paused", at: { unitIndex, offsetMs } });

const worker = (message: FromWorker): Event => ({ kind: "worker", message });
const reported = (state: PlayerState): Event => ({ kind: "player", state });
const audio = (unitId: number, frameIndex: number): Event => worker({ kind: "audio", unitId, frameIndex, pcm: frame(unitId, frameIndex) });
const done = (unitId: number, durationMs = 1000): Event => worker({ kind: "done", unitId, report: report(durationMs), elapsedMs: 10 });

const describeCommand = (command: Command): string => {
  if (command.kind === "worker") {
    const m = command.message;
    return m.kind === "synthesize" ? `synthesize ${m.unitId}` : m.kind === "cancel" ? `cancel ${m.unitId}` : m.kind;
  }
  const e = command.event;
  switch (e.kind) {
    case "frame":
      return `frame ${e.unit}#${e.frameIndex}`;
    case "complete":
    case "drop":
      return `${e.kind} ${e.unit}`;
    case "seek":
      return `seek ${e.to.unitIndex}:${e.to.offsetMs}`;
    default:
      return e.kind;
  }
};

const kinds = (state: SchedulerState): string => state.holdings.map((h) => h.kind[0]).join("");

// A pure run: feeds events in order against a stated position, returns the commands.
const run = (state: SchedulerState, player: PlayerState, ...events: Event[]): { state: SchedulerState; commands: string[] } => {
  const commands: string[] = [];
  for (const event of events) {
    const planned = step(VOICES, state, event, player);
    state = planned.state;
    commands.push(...planned.commands.map(describeCommand));
  }
  return { state, commands };
};

// ── the pure machine ──────────────────────────────────────────────────────────────────

console.log("step: from idle to the first audio");
{
  const fresh = initialState(scriptOf(6));
  const still = step(VOICES, fresh, reported(idle), idle);
  assert("idle: nothing requested, the state object is unchanged", still.commands.length === 0 && still.state === fresh);

  const played = run(fresh, speaking(0), reported(speaking(0)));
  assert("play with nothing held: the cursor unit is requested, nothing else", played.commands.join() === "synthesize 0" && kinds(played.state) === "raaaaa");
  const message = step(VOICES, fresh, reported(speaking(0)), speaking(0)).commands[0];
  assert(
    "the request carries the unit's text and the voice for its role",
    message?.kind === "worker" && message.message.kind === "synthesize" && message.message.text === "Unit 0 says hello." && message.message.voice === "marius",
  );

  const again = step(VOICES, played.state, reported(speaking(0)), speaking(0));
  assert("a second plan over the same position issues nothing and keeps the state object", again.commands.length === 0 && again.state === played.state);

  const streamed = run(played.state, speaking(0), audio(0, 0), audio(0, 1));
  assert("audio for the requested unit goes to the player as frames; the state object is unchanged", streamed.commands.join() === "frame 0#0,frame 0#1" && streamed.state === played.state);
  throws("audio for a unit never requested", () => step(VOICES, played.state, audio(3, 0), speaking(0)));
  throws("audio for a unit the worker never had", () => step(VOICES, played.state, audio(9, 0), speaking(0)));

  const first = run(played.state, speaking(0, 0, "audio"), done(0, 1500));
  assert("done: complete to the player, the unit held, the next requested", first.commands.join() === "complete 0,synthesize 1" && kinds(first.state) === "hraaaa");
  assert("the manifest records the unit's duration", first.state.manifest.units[0]?.durationMs === 1500 && first.state.manifest.units[1] === undefined);
  assert("the held holding shares the manifest's record", first.state.holdings[0]?.kind === "held" && first.state.holdings[0].record === first.state.manifest.units[0]);

  const ahead = run(first.state, speaking(0, 200, "audio"), done(1), done(2), done(3));
  assert("units keep being requested one at a time, and stop when three are held ahead", ahead.commands.join() === "complete 1,synthesize 2,complete 2,synthesize 3,complete 3" && kinds(ahead.state) === "hhhhaa");
  assert("the pure requester never has two in flight", !ahead.commands.join().includes("synthesize 2,synthesize 3"));

  const crossed = run(ahead.state, speaking(1, 10, "audio"), reported(speaking(1, 10, "audio")));
  assert("a boundary crossing slides the window: the fourth unit is requested, the one behind is kept", crossed.commands.join() === "synthesize 4" && kinds(crossed.state) === "hhhhra");
  const further = run(crossed.state, speaking(2, 10, "audio"), reported(speaking(2, 10, "audio")));
  assert(`the unit ${KEEP_BEHIND + 1} behind is dropped on the next crossing`, further.commands.join() === "drop 0" && kinds(further.state) === "ahhhra");
}

console.log("step: the time bound");
{
  const fresh = initialState(scriptOf(4));
  const long = run(fresh, speaking(0), reported(speaking(0)), done(0, 20_000), done(1, 20_000));
  assert(`${LOOKAHEAD.ms / 1000} s held ahead stops requests under ${LOOKAHEAD.units} units`, long.commands.join() === "synthesize 0,complete 0,synthesize 1,complete 1" && kinds(long.state) === "hhaa");
  const spent = run(long.state, speaking(0, 15_000, "audio"), reported(speaking(0, 15_000, "audio")));
  assert("the cursor unit's remaining audio counts: 25 s ahead at 15 s in requests again", spent.commands.join() === "synthesize 2");
}

console.log("step: seeks reprioritize");
{
  // Cursor at 1: units 0..4 held, 5 in flight.
  const fresh = initialState(scriptOf(20));
  const listened = run(fresh, speaking(1, 0, "audio"), reported(speaking(1, 0, "audio")), done(1), done(2), done(3), done(4), reported(speaking(1, 500, "audio")));
  assert("setup: four held ahead of a cursor at 1, none in flight", kinds(listened.state).startsWith("ahhhha") && !listened.commands.includes("synthesize 5"));
  const inFlight = run(listened.state, speaking(2, 0, "audio"), reported(speaking(2, 0, "audio")));
  assert("setup: crossing into 2 requests 5", inFlight.commands.join() === "synthesize 5" && kinds(inFlight.state).startsWith("ahhhhra"));

  const far = run(inFlight.state, speaking(10), reported(speaking(10)));
  assert(
    "seek far ahead: the held island is dropped, the in-flight unit cancelled and dropped, the target requested — in that order",
    far.commands.join() === "drop 1,drop 2,drop 3,drop 4,cancel 5,drop 5,synthesize 10",
  );
  assert("state: 5 is cancelling, 10 requested", kinds(far.state) === "aaaaacaaaaraaaaaaaaa");

  const lateFrame = run(far.state, speaking(10), audio(5, 7));
  assert("a frame of the cancelling unit is discarded", lateFrame.commands.length === 0 && lateFrame.state === far.state);
  const terminal = run(far.state, speaking(10), worker({ kind: "cancelled", unitId: 5 }));
  assert("cancelled: the unit is absent again; nothing requested while 10 is in flight", terminal.commands.length === 0 && kinds(terminal.state) === "aaaaaaaaaaraaaaaaaaa");
  const racedDone = run(far.state, speaking(10), done(5));
  assert("done racing a cancel: absent, no complete, no record", racedDone.commands.length === 0 && kinds(racedDone.state)[5] === "a" && racedDone.state.manifest.units[5] === undefined);
  const racedFail = run(far.state, speaking(10), worker({ kind: "failed", unitId: 5, reason: { kind: "runtime", message: "x" } }));
  assert("failed racing a cancel: absent", racedFail.commands.length === 0 && kinds(racedFail.state)[5] === "a");
  throws("cancelled for a unit that was not cancelled", () => step(VOICES, terminal.state, worker({ kind: "cancelled", unitId: 10 }), speaking(10)));

  // Now 10 held, 11 in flight; the reader seeks back to 9, which is absent.
  const settled = run(terminal.state, speaking(10, 0, "audio"), done(10));
  assert("setup: 10 held, 11 requested", settled.commands.join() === "complete 10,synthesize 11");
  const back = run(settled.state, speaking(9), reported(speaking(9)));
  assert("seek back to an absent unit: the in-flight unit, still in window, is cancelled so the wanted one starts first", back.commands.join() === "cancel 11,drop 11,synthesize 9");
  const resumedAhead = run(back.state, speaking(9), worker({ kind: "cancelled", unitId: 11 }));
  assert("its cancellation lands while 9 is in flight: nothing more is requested yet", resumedAhead.commands.length === 0 && kinds(resumedAhead.state).slice(9, 12) === "rha");
}

console.log("step: the frontier and the contiguous run");
{
  const fresh = initialState(scriptOf(12));
  // 0..3 held, 4 in flight with frames streaming, 6..9 held from an earlier listen: cursor back at 0.
  const four = run(fresh, speaking(0), reported(speaking(0)), done(0), done(1), done(2), done(3));
  const built = run(four.state, speaking(1, 0, "audio"), reported(speaking(1, 0, "audio")), audio(4, 0), audio(4, 1));
  assert("setup: 0..3 held, 4 requested", kinds(built.state).startsWith("hhhhraaa"));
  const withIsland: SchedulerState = {
    ...built.state,
    holdings: built.state.holdings.map((h, i) => (i >= 6 && i <= 9 ? (built.state.holdings[0] as Holding) : h)),
  };
  const rewound = run(withIsland, speaking(0, 0, "audio"), reported(speaking(0, 0, "audio")));
  assert(
    "the frontier in flight past the window is neither cancelled nor dropped; the island beyond it is dropped",
    rewound.commands.join() === "drop 6,drop 7,drop 8,drop 9" && kinds(rewound.state) === "hhhhraaaaaaa",
  );

  const at1 = run(four.state, speaking(1, 0, "audio"), reported(speaking(1, 0, "audio")), done(4));
  const at2 = run(at1.state, speaking(2, 0, "audio"), reported(speaking(2, 0, "audio")), done(5));
  const contiguous = run(at2.state, speaking(3, 0, "audio"), reported(speaking(3, 0, "audio")), done(6));
  assert("setup: a run 2..6 held with the cursor at 3", kinds(contiguous.state) === "aahhhhhaaaaa");
  const rewind = run(contiguous.state, speaking(2, 0, "audio"), reported(speaking(2, 0, "audio")));
  assert("a rewind inside held audio keeps the whole contiguous run, past the window", rewind.commands.length === 0 && kinds(rewind.state) === "aahhhhhaaaaa");
  const rewindFar = run(contiguous.state, speaking(0), reported(speaking(0)));
  assert("a rewind to an absent unit before the run requests it and keeps only the run's units inside the window: the rest is an island, dropped now", rewindFar.commands.join() === "drop 4,drop 5,drop 6,synthesize 0" && kinds(rewindFar.state) === "rahhaaaaaaaa");
}

console.log("step: failure is skipped, not waited on");
{
  const fresh = initialState(scriptOf(4));
  const going = run(fresh, speaking(0, 0, "audio"), reported(speaking(0)), done(0), done(1), audio(2, 0));
  assert("setup: 0, 1 held; 2 requested with a frame in the player", going.commands.join() === "synthesize 0,complete 0,synthesize 1,complete 1,synthesize 2,frame 2#0");
  const capped = run(going.state, speaking(0, 0, "audio"), worker({ kind: "failed", unitId: 2, reason: { kind: "frame-cap", frames: 1000 } }));
  assert("failed at the frontier: frames stay (the player is cueing them), the unit after it is requested", capped.commands.join() === "synthesize 3" && kinds(capped.state) === "hhfr");
  assert("the failure is readable with its reason", capped.state.holdings[2]?.kind === "failed" && capped.state.holdings[2].reason.kind === "frame-cap" && capped.state.holdings[2].frames === "player");
  const reached = run(capped.state, speaking(2, 5, "audio"), reported(speaking(2, 5, "audio")));
  assert("the cursor entering the failed unit: seek past it, then drop its frames", reached.commands.join() === "seek 3:0,drop 2" && capped.state.holdings[2] !== reached.state.holdings[2] && reached.state.holdings[2]?.kind === "failed" && reached.state.holdings[2].frames === "none");
  const onward = run(reached.state, speaking(3), reported(speaking(3)));
  assert("at the next unit, already in flight, nothing more is asked; the units now two behind are dropped", onward.commands.join() === "drop 0,drop 1" && kinds(onward.state) === "aafr");
  const lastFails = run(onward.state, speaking(3), worker({ kind: "failed", unitId: 3, reason: { kind: "runtime", message: "boom" } }));
  assert("the last unit failing under the cursor: stop, drop", lastFails.commands.join() === "stop,drop 3");
  const ended = run(lastFails.state, idle, reported(idle));
  assert("idle after the stop: nothing left to drop", ended.commands.length === 0 && kinds(ended.state) === "aaff");
  const cutShort = run(going.state, idle, reported(idle));
  assert("idle with units held and in flight: everything dropped, the request withdrawn", cutShort.commands.join() === "drop 0,drop 1,cancel 2,drop 2" && kinds(cutShort.state) === "aaca");
  const replay = run(ended.state, speaking(2), reported(speaking(2)));
  assert("seeking into a failed unit later skips it again without a request", replay.commands.join() === "seek 3:0");
  const pausedAtFailed = run(ended.state, paused(2), reported(paused(2)));
  assert("paused at a failed unit moves the held position past it", pausedAtFailed.commands.join() === "seek 3:0");

  const notFrontier = run(fresh, speaking(0), reported(speaking(0)), done(0), done(1), audio(2, 0), audio(2, 1));
  const staleState: SchedulerState = { ...notFrontier.state, holdings: notFrontier.state.holdings.with(1, { kind: "absent" }) };
  const failedBehindGap = run(staleState, speaking(0, 0, "audio"), worker({ kind: "failed", unitId: 2, reason: { kind: "runtime", message: "x" } }));
  assert("failed when not the frontier: frames dropped at once, the gap requested", failedBehindGap.commands.join() === "drop 2,synthesize 1");

  throws("failed{duplicate-unit} is a scheduler bug", () => step(VOICES, going.state, worker({ kind: "failed", unitId: 2, reason: { kind: "duplicate-unit" } }), speaking(0)));
  throws("a refused synthesize is a scheduler bug", () => step(VOICES, going.state, worker({ kind: "refused", request: { kind: "synthesize", unitId: 2, text: "", voice: "alba" }, phase: "idle" }), speaking(0)));
  throws("a refused cancel is a scheduler bug", () => step(VOICES, going.state, worker({ kind: "refused", request: { kind: "cancel", unitId: 2 }, phase: "idle" }), speaking(0)));
  const others = run(going.state, speaking(0), worker({ kind: "refused", request: { kind: "load" }, phase: "ready" }), worker({ kind: "progress", progress: { loadedBytes: 1, totalBytes: 2 } }), worker({ kind: "capability", support: { kind: "supported", backend: "webgpu" } }));
  assert("the panel's messages pass by untouched", others.commands.length === 0 && others.state === going.state);
}

console.log("step: a report the manifest rejects");
{
  const script = [unitOf(0, "One two three."), unitOf(1, "Four five.")];
  const fresh = initialState(script);
  const started = run(fresh, speaking(0), reported(speaking(0)), audio(0, 0));
  const rejected = run(
    started.state,
    speaking(0),
    worker({ kind: "done", unitId: 0, report: { durationMs: 1000, alignment: { kind: "words", times: [{ startMs: 0, endMs: 100 }] } }, elapsedMs: 1 }),
  );
  const holding = rejected.state.holdings[0];
  assert("word-count mismatch: the unit is failed with the rejection, no complete, no record", holding?.kind === "failed" && holding.reason.kind === "word-count" && rejected.state.manifest.units[0] === undefined && !rejected.commands.includes("complete 0"));
  assert("(fixture sanity: the unit has three words)", wordsOf(script[0] as SynthesisUnit).length === 3);
}

console.log("step: paused, and re-synthesis");
{
  const fresh = initialState(scriptOf(5));
  const held = run(fresh, paused(1), reported(paused(1)), done(1, 700));
  assert("paused synthesizes ahead exactly as speaking does", held.commands.join() === "synthesize 1,complete 1,synthesize 2");
  const away = run(held.state, speaking(4), reported(speaking(4)));
  assert("a seek away drops 1 and cancels 2", away.commands.join() === "drop 1,cancel 2,drop 2,synthesize 4");
  assert("the record of the dropped unit survives for the timeline", away.state.manifest.units[1]?.durationMs === 700);
  const backAgain = run(away.state, speaking(1), reported(speaking(1)), worker({ kind: "cancelled", unitId: 2 }));
  assert("back at 1: 4 cancelled, 1 requested again", backAgain.commands.join() === "cancel 4,drop 4,synthesize 1");
  const redone = run(backAgain.state, speaking(1), done(1, 760));
  assert("the second rendition replaces the record", redone.state.manifest.units[1]?.durationMs === 760 && redone.commands.includes("complete 1"));
}

// ── the driver, over the real player ──────────────────────────────────────────────────

console.log("driver: a stub port, the real player, a hand-moved clock");
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

  const views: SchedulerView[] = [];
  const script = scriptOf(4);
  const scheduler = createScheduler({
    port,
    script,
    voices: VOICES,
    player: (config) => createUnitPlayer({ ...config, Device: StubDevice }),
    onChange: (view) => views.push(view),
  });
  const device = StubDevice.instances.at(-1);
  if (device === undefined) throw new Error("the scheduler did not build its player");

  assert("fresh: idle, nothing sent, one subscriber", scheduler.view().player.kind === "idle" && sent.length === 0 && listeners.size === 1);

  scheduler.send({ kind: "play" });
  assert("play: the player waits at 0 and unit 0 is requested", describe(scheduler.view().player) === "speaking/waiting@0:0.000" && said() === "synthesize 0");
  assert("the view reported the change", views.length === 1 && describe(views[0]?.player ?? idle) === "speaking/waiting@0:0.000");

  emit({ kind: "audio", unitId: 0, frameIndex: 0, pcm: frame(0, 0) });
  emit({ kind: "audio", unitId: 0, frameIndex: 1, pcm: frame(0, 1) });
  assert("frames reach the player and play: two sources, flow audio", device.sources.length === 2 && describe(scheduler.view().player) === "speaking/audio@0:0.000");
  emit({ kind: "done", unitId: 0, report: report(2 * FRAME_S * 1000), elapsedMs: 5 });
  assert("done 0: unit 1 requested; the view holds the record", said() === "synthesize 0,synthesize 1" && scheduler.view().manifest.units[0]?.durationMs === 160);
  emit({ kind: "audio", unitId: 1, frameIndex: 0, pcm: frame(1, 0) });
  const boundary = device.sources[2];
  assert("unit 1's first frame is scheduled at unit 0's last sample end — gapless through the scheduler", boundary?.started?.when === device.sources[1]?.endTime());
  emit({ kind: "done", unitId: 1, report: report(FRAME_S * 1000), elapsedMs: 5 });
  emit({ kind: "audio", unitId: 2, frameIndex: 0, pcm: frame(2, 0) });
  emit({ kind: "done", unitId: 2, report: report(FRAME_S * 1000), elapsedMs: 5 });
  emit({ kind: "audio", unitId: 3, frameIndex: 0, pcm: frame(3, 0) });
  emit({ kind: "done", unitId: 3, report: report(FRAME_S * 1000), elapsedMs: 5 });
  assert("every unit requested once, in order", said() === "synthesize 0,synthesize 1,synthesize 2,synthesize 3");
  assert("all four held", scheduler.view().holdings.every((h) => h.kind === "held"));

  device.advance(SCHEDULE_LEAD_S + 2 * FRAME_S + 0.01);
  assert("crossing into 1: reported, nothing dropped yet", describe(scheduler.view().player) === "speaking/audio@1:10.000" && scheduler.view().holdings[0]?.kind === "held");
  device.advance(FRAME_S);
  assert("crossing into 2: unit 0 dropped behind the cursor, the view says absent", scheduler.view().holdings[0]?.kind === "absent" && scheduler.view().holdings[1]?.kind === "held");
  assert("the manifest still knows unit 0's length", scheduler.view().manifest.units[0]?.durationMs === 160);

  // A seek back into the dropped unit: the player waits there, the scheduler re-requests
  // it, and the report the player raised inside the seek was handled after the seek.
  scheduler.send({ kind: "seek", to: { unitIndex: 0, offsetMs: 0 } });
  assert("seek to the dropped unit: waiting there, requested again", describe(scheduler.view().player) === "speaking/waiting@0:0.000" && said().endsWith("synthesize 0"));
  emit({ kind: "audio", unitId: 0, frameIndex: 0, pcm: frame(0, 0) });
  assert("its fresh frame 0 is accepted and plays", describe(scheduler.view().player) === "speaking/audio@0:0.000");

  const before = sent.length;
  scheduler.dispose();
  assert("dispose: the player is idle, the in-flight unit cancelled, the port no longer heard, the device closed", scheduler.view().player.kind === "idle" && sent.slice(before).some((m) => m.kind === "cancel" && m.unitId === 0) && listeners.size === 0 && device?.calls.at(-1) === "close");
  emit({ kind: "audio", unitId: 0, frameIndex: 1, pcm: frame(0, 1) });
  assert("a message after dispose changes nothing", scheduler.view().player.kind === "idle");
}

console.log(process.exitCode === 1 ? "scheduler-check: FAILED" : "scheduler-check: ok");
