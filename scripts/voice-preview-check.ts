// The voice preview (slopspot-read-along-a35.7): the pure `step` through its accept table,
// then the driver over a stub synthesis port and the REAL unit player on the stub playback
// device — so the player's own contract is enforced on the previewer's commands, and the
// device a preview opens is the check's to inspect. Run: `tsx scripts/voice-preview-check.ts`.
//
// [LAW:behavior-not-structure] Every assertion is about what the worker would be asked,
// what the reader would hear and what the picker would be told is sounding.
//
// ─── ACCEPT TABLE (event × state) ───────────────────────────────────────────────
//   say, silent                   -> synthesize under the next id below zero, in that voice; play
//   say, sounding                 -> the sounding request withdrawn first; a fresh id
//   audio | done for the sounding -> frame | complete to its player
//   audio | done for another id   -> ignored (a replaced preview's, or the script's)
//   failed for the sounding       -> silent, nothing sent
//   cancelled for the sounding    -> Error (a previewer bug)
//   refused, id below zero        -> Error (sounding or not); other refusals and the panel's messages ignored
//   player idle for the sounding  -> silent: the phrase was said
//   player idle for another id    -> ignored
//   hush, sounding                -> the request withdrawn, silent
//   hush, silent                  -> nothing
//   driver: the device is opened on the first say, one player per preview, a replaced
//           preview's player is ended before the new one plays (the device stays resumed)
//   driver: onChange says the voice sounding, and null once it is over, failed or hushed
//   driver: dispose hushes, closes the device, stops hearing the port, tells nobody

import type { SynthesisPort } from "../src/synthesisClient";
import type { FromWorker, ToWorker } from "../src/synthesisProtocol";
import { SCHEDULE_LEAD_S } from "../src/unitPlayer";
import { previewText } from "../src/voiceChoice";
import { createPreviewer, initialState, step } from "../src/voicePreview";
import type { PreviewCommand, PreviewEvent, PreviewState } from "../src/voicePreview";
import { FRAME_S, StubDevice, frame } from "./playbackStub";

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

const worker = (message: FromWorker): PreviewEvent => ({ kind: "worker", message });
const audio = (unitId: number, frameIndex = 0): PreviewEvent => worker({ kind: "audio", unitId, frameIndex, pcm: frame(0, frameIndex) });
const done = (unitId: number): PreviewEvent => worker({ kind: "done", unitId, report: { durationMs: FRAME_S * 1000, alignment: { kind: "unit" } }, elapsedMs: 1 });
const failed = (unitId: number): PreviewEvent => worker({ kind: "failed", unitId, reason: { kind: "runtime", message: "x" } });
const idleOf = (unitId: number): PreviewEvent => ({ kind: "player", unitId, state: { kind: "idle" } });

const describeCommand = (command: PreviewCommand): string => {
  if (command.kind === "worker") {
    const m = command.message;
    return m.kind === "synthesize" ? `synthesize ${m.unitId} ${m.voice}` : m.kind === "cancel" ? `cancel ${m.unitId}` : m.kind;
  }
  const e = command.event;
  return `${e.kind === "frame" ? `frame ${e.unit}#${e.frameIndex}` : e.kind === "complete" || e.kind === "drop" ? `${e.kind} ${e.unit}` : e.kind}@${command.unitId}`;
};

const sounding = (state: PreviewState): string => (state.sounding === null ? "silent" : `${state.sounding.voice}@${state.sounding.unitId}`);

const run = (state: PreviewState, ...events: PreviewEvent[]): { state: PreviewState; commands: string[] } => {
  const commands: string[] = [];
  for (const event of events) {
    const planned = step(state, event);
    state = planned.state;
    commands.push(...planned.commands.map(describeCommand));
  }
  return { state, commands };
};

// ── the pure machine ──────────────────────────────────────────────────────────────────

console.log("step: hearing a voice out");
{
  const fresh = initialState();
  assert("fresh: silent, the first id is -1", sounding(fresh) === "silent" && fresh.next === -1);
  const first = run(fresh, { kind: "say", voice: "alba" });
  assert("say: synthesize under -1 in that voice, then play — on a player answering to -1", first.commands.join() === "synthesize -1 alba,play@-1" && sounding(first.state) === "alba@-1" && first.state.next === -2);
  const request = step(fresh, { kind: "say", voice: "alba" }).commands[0];
  assert("the request carries the preview phrase, in the voice's own name", request?.kind === "worker" && request.message.kind === "synthesize" && request.message.text.text === previewText("alba").text);

  const streamed = run(first.state, audio(-1, 0), audio(-1, 1), done(-1));
  assert("its frames and its end go to its player as unit 0", streamed.commands.join() === "frame 0#0@-1,frame 0#1@-1,complete 0@-1" && streamed.state === first.state);
  const said = run(streamed.state, idleOf(-1));
  assert("its player idle: the phrase was said, silent again", said.commands.length === 0 && sounding(said.state) === "silent" && said.state.next === -2);

  const replaced = run(first.state, { kind: "say", voice: "marius" });
  assert("say while sounding: the old request withdrawn, a fresh id, the new one played", replaced.commands.join() === "cancel -1,synthesize -2 marius,play@-2" && sounding(replaced.state) === "marius@-2" && replaced.state.next === -3);
  const stale = run(replaced.state, audio(-1, 3), done(-1), worker({ kind: "cancelled", unitId: -1 }), failed(-1), idleOf(-1));
  assert("everything of the replaced preview is ignored", stale.commands.length === 0 && stale.state === replaced.state);
  const foreign = run(replaced.state, audio(0, 0), done(0), audio(5, 1));
  assert("the script's units, ids at or above zero, are another conversation", foreign.commands.length === 0 && foreign.state === replaced.state);
  const notIdle = run(replaced.state, { kind: "player", unitId: -2, state: { kind: "speaking", at: { unitIndex: 0, offsetMs: 0 }, flow: "audio" } });
  assert("its player speaking is not its end", notIdle.commands.length === 0 && notIdle.state === replaced.state);

  const lost = run(replaced.state, failed(-2));
  assert("failed: silent, nothing sent, the id spent", lost.commands.length === 0 && sounding(lost.state) === "silent" && lost.state.next === -3);
  const hushed = run(replaced.state, { kind: "hush" });
  assert("hush while sounding: the request withdrawn, silent", hushed.commands.join() === "cancel -2" && sounding(hushed.state) === "silent");
  const quiet = run(hushed.state, { kind: "hush" }, audio(-2, 0), done(-2), idleOf(-2));
  assert("hush while silent, and the withdrawn preview's messages: nothing", quiet.commands.length === 0 && quiet.state === hushed.state);
  const next = run(hushed.state, { kind: "say", voice: "fantine" });
  assert("the next say takes the next id down", next.commands.join() === "synthesize -3 fantine,play@-3");

  throws("cancelled for the sounding preview is a previewer bug", () => step(replaced.state, worker({ kind: "cancelled", unitId: -2 })));
  throws("a refused preview is a previewer bug", () => step(replaced.state, worker({ kind: "refused", request: { kind: "synthesize", unitId: -2, text: previewText("marius"), voice: "marius" }, phase: "idle" })));
  throws("a refused synthesize of a replaced preview is one too", () => step(replaced.state, worker({ kind: "refused", request: { kind: "synthesize", unitId: -1, text: previewText("alba"), voice: "alba" }, phase: "idle" })));
  throws("a refused cancel after a hush, nothing sounding, is one too", () => step(run(replaced.state, { kind: "hush" }).state, worker({ kind: "refused", request: { kind: "cancel", unitId: -2 }, phase: "idle" })));
  const others = run(replaced.state, worker({ kind: "refused", request: { kind: "load" }, phase: "ready" }), worker({ kind: "progress", progress: { loadedBytes: 1, totalBytes: 2 } }), worker({ kind: "refused", request: { kind: "synthesize", unitId: 0, text: previewText("alba"), voice: "alba" }, phase: "idle" }));
  assert("the panel's messages and the script's refusals pass by untouched", others.commands.length === 0 && others.state === replaced.state);
}

// ── the driver, over the real player ──────────────────────────────────────────────────

console.log("driver: a stub port, one real player per preview, a device of its own");
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
  const said = (): string => sent.map((m) => (m.kind === "synthesize" ? `synthesize ${m.unitId} ${m.voice}` : m.kind === "cancel" ? `cancel ${m.unitId}` : m.kind)).join();
  const changes: (string | null)[] = [];
  const opened = StubDevice.instances.length;
  const devices = (): StubDevice[] => StubDevice.instances.slice(opened);

  const previewer = createPreviewer({ port, Device: StubDevice, onChange: (voice) => changes.push(voice) });
  assert("fresh: no device, nothing sent, one subscriber, nobody told", devices().length === 0 && sent.length === 0 && listeners.size === 1 && changes.length === 0);

  previewer.say("alba");
  const device = devices()[0];
  if (device === undefined) throw new Error("the first say did not open a device");
  assert("the first say opens the device and resumes it — the tap's gesture — and asks for the phrase", devices().length === 1 && device.calls.join() === "resume" && said() === "synthesize -1 alba" && changes.join() === "alba");
  emit({ kind: "audio", unitId: -1, frameIndex: 0, pcm: frame(0, 0) });
  emit({ kind: "done", unitId: -1, report: { durationMs: FRAME_S * 1000, alignment: { kind: "unit" } }, elapsedMs: 1 });
  assert("the phrase plays on the preview's device", device.sources.length === 1 && device.sources[0]?.started !== null);
  emit({ kind: "audio", unitId: 0, frameIndex: 0, pcm: frame(0, 0) });
  assert("a frame of the script's unit 0 is not played here", device.sources.length === 1);
  device.advance(SCHEDULE_LEAD_S + FRAME_S + 0.01);
  assert("the phrase ends: silent, and the picker told", previewer.state().sounding === null && changes.join() === "alba," && device.calls.at(-1) === "suspend");

  previewer.say("marius");
  previewer.say("fantine");
  assert("a second voice tapped over the first: the first withdrawn, the second asked", said() === "synthesize -1 alba,synthesize -2 marius,cancel -2,synthesize -3 fantine" && changes.join() === "alba,,marius,fantine");
  assert("the replaced preview's player is ended before the new one plays: the device is resumed, not suspended", device.calls.at(-1) === "resume" && devices().length === 1);
  emit({ kind: "audio", unitId: -2, frameIndex: 0, pcm: frame(0, 0) });
  assert("a late frame of the replaced preview is not played", device.sources.length === 1);
  emit({ kind: "cancelled", unitId: -2 });
  emit({ kind: "audio", unitId: -3, frameIndex: 0, pcm: frame(0, 0) });
  assert("the sounding preview's frame plays", device.sources.length === 2 && previewer.state().sounding?.voice === "fantine");
  previewer.hush();
  assert("hush: the request withdrawn, silent, the picker told, the device suspended", said().endsWith("cancel -3") && previewer.state().sounding === null && changes.at(-1) === null && device.calls.at(-1) === "suspend");

  previewer.say("javert");
  emit({ kind: "failed", unitId: -4, reason: { kind: "frame-cap", frames: 1000 } });
  assert("a preview that fails: silent, the picker told", previewer.state().sounding === null && changes.slice(-2).join() === "javert,");

  previewer.say("azelma");
  const before = changes.length;
  previewer.dispose();
  assert("dispose: the request withdrawn, the port unheard, the device closed, nobody told", said().endsWith("synthesize -5 azelma,cancel -5") && listeners.size === 0 && device.calls.at(-1) === "close" && changes.length === before);
}

console.log(process.exitCode === 1 ? "voice-preview-check: FAILED" : "voice-preview-check: ok");
