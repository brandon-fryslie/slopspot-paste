// The making of clones (slopspot-voices-9p4.8j6): the machine's every arm — a recording
// stopped, a file too short, one voice at a time, a store that refuses to keep and one that
// refuses to forget — and the driver over a stub microphone and decoder, with the capture
// edge's own rules: the recording ends on the reader's tap or at the cap, either end is
// announced, the channels are averaged and the tail cut. Run:
// `tsx scripts/voice-cloning-check.ts`.

import { CLONE_SAMPLES, CLONE_SECONDS, cloneVoice, readClones, writeClones, type ClonedVoice } from "../src/clonedVoice";
import { SAMPLE_RATE } from "../src/modelAssets";
import type { PreferenceStore } from "../src/preferenceStore";
import { createVoiceCapture, monoOf, type Capture, type Recorder, type Stream, type VoiceCapture } from "../src/voiceCapture";
import { BUSY, REFUSED, REMOVAL_REFUSED, createCloning, initialCloning, step, type CloningEvent, type CloningState } from "../src/voiceCloning";
import { memoryPreferences } from "./preferenceStub";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

// Whether a promise resolved — never a hang if it does not: a settle's worth of turns is
// every turn a resolved one needs.
const settled = async (promise: Promise<void>): Promise<boolean> => Promise.race([promise.then(() => true), settle().then(() => false)]);

const tone = (seconds: number, scale = 0.5): Float32Array<ArrayBuffer> => Float32Array.from({ length: Math.round(seconds * SAMPLE_RATE) }, (_, i) => scale * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE));

const shown = (state: CloningState): string =>
  `${state.phase.kind === "idle" ? "idle" : `${state.phase.kind} ${state.phase.name}`}${state.note === null ? "" : `: ${state.note}`}`;
const effects = (state: CloningState, ...events: CloningEvent[]): string => {
  const made: string[] = [];
  for (const event of events) {
    const planned = step(state, event);
    state = planned.state;
    made.push(...planned.effects.map((e) => e.kind));
  }
  return made.join();
};

const file = new Blob([new Uint8Array(16)]);

console.log("step: one voice at a time, and every way a making ends");
{
  const idle = initialCloning();
  const recording = step(idle, { kind: "make", name: "Me", source: { kind: "microphone" } });
  assert("a record from idle: recording, the microphone captured", shown(recording.state) === "recording Me" && effects(idle, { kind: "make", name: "Me", source: { kind: "microphone" } }) === "capture");
  const making = step(idle, { kind: "make", name: "Me", source: { kind: "file", file } });
  assert("an upload from idle: making at once — there is nothing to stop", shown(making.state) === "making Me" && making.effects[0]?.kind === "capture");
  const busy = step(recording.state, { kind: "make", name: "Again", source: { kind: "microphone" } });
  assert(
    "a second make while one is under way starts nothing, and the note says why",
    busy.effects.length === 0 && shown(busy.state) === `recording Me: ${BUSY}` && effects(making.state, { kind: "make", name: "Again", source: { kind: "file", file } }) === "",
  );
  const stopped = step(recording.state, { kind: "stop" });
  assert("stop while recording: the capture is stopped and the making begins", shown(stopped.state) === "making Me" && stopped.effects.map((e) => e.kind).join() === "stop");
  assert("stop while idle or making changes nothing", effects(idle, { kind: "stop" }) === "" && effects(making.state, { kind: "stop" }) === "");
  const voice: ClonedVoice = { key: `clone:${"b".repeat(64)}`, name: "Me", samples: new Int16Array(new ArrayBuffer(48000)) };
  assert("made while making: kept", effects(making.state, { kind: "made", voice }) === "keep");
  assert("made while idle is kept all the same: a finished recording is never dropped", effects(idle, { kind: "made", voice }) === "keep");
  assert("kept: idle, saying so", shown(step(making.state, { kind: "kept", voice }).state) === "idle: Saved Me.");
  assert("failed: idle, saying why", shown(step(recording.state, { kind: "failed", message: "no microphone" }).state) === "idle: Could not make the voice: no microphone");
  assert("remove: forgotten, wherever the making is", effects(idle, { kind: "remove", key: voice.key }) === "forget" && effects(recording.state, { kind: "remove", key: voice.key }) === "forget");
  assert("remove: the word about the voice just saved goes with its row", shown(step(step(making.state, { kind: "kept", voice }).state, { kind: "remove", key: voice.key }).state) === "idle");
  const stuck = step(recording.state, { kind: "remove-refused" });
  assert("a removal the store refuses is said, and the recording under way is left alone", stuck.effects.length === 0 && shown(stuck.state) === `recording Me: ${REMOVAL_REFUSED}`);
  const refused = step(recording.state, { kind: "model-refused", name: "Me", message: "out of memory" });
  assert(
    "the model refusing a saved clone is said, and the recording under way is left alone",
    refused.effects.length === 0 && shown(refused.state) === "recording Me: Me cannot be spoken on this device: out of memory",
  );
}

// ── the capture edge over a stub browser ──────────────────────────────────────────────

interface Mic {
  readonly stream: Stream & { readonly stopped: () => number };
  readonly recorder: () => Recorder & { readonly started: () => number };
  readonly answer: (blob: Blob) => void;
}

// A stub microphone: a stream whose tracks count their stops, and a recorder that hands its
// listeners one chunk — the bytes the decoder will read as `decoded` — when stopped.
const stubMic = (chunk: Blob): Mic => {
  let stopped = 0;
  const stream = { getTracks: () => [{ stop: () => void (stopped += 1) }], stopped: () => stopped };
  let started = 0;
  let live: Recorder | null = null;
  const recorder = (): Recorder & { readonly started: () => number } => {
    const listeners = { data: [] as Array<(event: { readonly data: Blob }) => void>, stop: [] as Array<() => void>, error: [] as Array<(event: { readonly error?: unknown }) => void> };
    let state: Recorder["state"] = "inactive";
    const made: Recorder & { readonly started: () => number } = {
      start: () => {
        started += 1;
        state = "recording";
      },
      stop: () => {
        state = "inactive";
        for (const on of listeners.data) on({ data: chunk });
        for (const on of listeners.stop) on();
      },
      get state() {
        return state;
      },
      addEventListener: ((type: string, listener: (event: never) => void) => {
        if (type === "dataavailable") listeners.data.push(listener as (event: { readonly data: Blob }) => void);
        if (type === "stop") listeners.stop.push(listener as () => void);
        if (type === "error") listeners.error.push(listener as (event: { readonly error?: unknown }) => void);
      }) as Recorder["addEventListener"],
      started: () => started,
    };
    live = made;
    return made;
  };
  return { stream, recorder, answer: () => live?.stop() };
};

// A stub decoder: whatever bytes it is handed decode to `audio`.
const decoderOf = (audio: { numberOfChannels: number; length: number; getChannelData: (c: number) => Float32Array }) => ({ decodeAudioData: async () => audio });

const stereo = (left: Float32Array, right: Float32Array) => ({ numberOfChannels: 2, length: left.length, getChannelData: (c: number) => (c === 0 ? left : right) });

console.log("the capture edge: decode, mixdown, cut, and who ends a recording");
{
  const left = tone(2, 0.4);
  const right = tone(2, 0.2);
  const mono = monoOf(stereo(left, right));
  assert("channels are averaged to one", mono.length === left.length && Math.abs(mono[100]! - (left[100]! + right[100]!) / 2) < 1e-6);
  assert("a recording longer than a clone is cut to one", monoOf(stereo(tone(12), tone(12))).length === CLONE_SAMPLES);

  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const mic = stubMic(new Blob([new Uint8Array(4)]));
  let asked = 0;
  const capture: VoiceCapture = createVoiceCapture({
    Decoder: () => decoderOf(stereo(left, right)),
    microphone: async () => {
      asked += 1;
      return mic.stream;
    },
    Recorder: () => mic.recorder(),
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms, cleared: false });
      return timers.length - 1;
    },
    clearTimeout: (handle) => {
      timers[handle as number]!.cleared = true;
    },
  });
  assert("a file decodes to the model's mono waveform, no microphone asked", (await capture.decode(file)).length === left.length && asked === 0);

  const recording: Capture = capture.record();
  await settle();
  assert("a recording asks the microphone once, starts the recorder, and arms the cap", asked === 1 && timers.length === 1 && timers[0]?.ms === CLONE_SECONDS * 1000);
  recording.stop();
  const pcm = await recording.pcm;
  assert(
    "the reader's stop ends it: the chunk is decoded, the end announced, the cap disarmed, the microphone released",
    pcm.length === left.length && (await settled(recording.ended)) && timers[0]?.cleared === true && mic.stream.stopped() === 1,
  );

  const capped = capture.record();
  await settle();
  timers[1]!.fn();
  assert("the cap ends it the same way, announced the same way — nobody tapped anything", (await capped.pcm).length === left.length && (await settled(capped.ended)) && mic.stream.stopped() === 2);

  const early = capture.record();
  early.stop();
  let refused = "";
  await early.pcm.catch((e: unknown) => (refused = e instanceof Error ? e.message : String(e)));
  assert("a stop before the microphone answered records nothing, says so, and still releases the microphone", refused.includes("before it began") && mic.stream.stopped() === 3);

  const denied = createVoiceCapture({ Decoder: () => decoderOf(stereo(left, right)), microphone: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")), Recorder: () => mic.recorder(), setTimeout: () => 0, clearTimeout: () => {} });
  let why = "";
  await denied.record().pcm.catch((e: unknown) => (why = e instanceof Error ? e.message : String(e)));
  assert("a microphone the browser denies is the browser's own reason", why === "Permission denied");
}

// ── the driver ─────────────────────────────────────────────────────────────────────────

interface Rig {
  readonly store: PreferenceStore & { readonly keys: () => string[] };
  readonly states: string[];
  readonly kept: string[];
  readonly forgot: string[];
  readonly cloner: ReturnType<typeof createCloning>;
  readonly stops: () => number;
  // The capture edge's own cap firing: the recording is over with no tap to stop it.
  readonly cap: () => void;
}

const rig = (pcm: Float32Array<ArrayBuffer>, store = memoryPreferences()): Rig => {
  const states: string[] = [];
  const kept: string[] = [];
  const forgot: string[] = [];
  let stops = 0;
  let resolve: (pcm: Float32Array<ArrayBuffer>) => void = () => undefined;
  let over: () => void = () => undefined;
  const end = (): void => {
    over();
    resolve(pcm);
  };
  const capture: VoiceCapture = {
    record: () => ({
      pcm: new Promise((r) => (resolve = r)),
      ended: new Promise<void>((r) => (over = r)),
      stop: () => {
        stops += 1;
        end();
      },
    }),
    decode: async () => pcm,
  };
  const cloner = createCloning({ store, capture, onChange: (state) => states.push(shown(state)), onKept: (voice) => kept.push(voice.name), onForgot: (key) => forgot.push(key) });
  return { store, states, kept, forgot, cloner, stops: () => stops, cap: end };
};

console.log("createCloning: a recording becomes a kept clone the panel is told of");
{
  const r = rig(tone(2));
  r.cloner.send({ kind: "make", name: "Brandon", source: { kind: "microphone" } });
  assert("recording", r.states.join(" | ") === "recording Brandon");
  r.cloner.send({ kind: "stop" });
  await settle();
  assert("stop: the capture stopped, the clone made and kept, the panel told, the form saying so", r.stops() === 1 && r.states.join(" | ") === "recording Brandon | making Brandon | idle: Saved Brandon." && r.kept.join() === "Brandon" && readClones(r.store).map((c) => c.name).join() === "Brandon");
  const key = readClones(r.store)[0]!.key;
  r.cloner.send({ kind: "make", name: "File", source: { kind: "file", file } });
  await settle();
  assert("an upload of the same recording: the same key, now under the newer name", r.states.at(-1) === "idle: Saved File." && readClones(r.store).map((c) => `${c.name}:${c.key === key}`).join() === "File:true");
  r.cloner.send({ kind: "remove", key });
  assert("remove: forgotten on the device, the panel told, and the form says nothing about a voice that is gone", readClones(r.store).length === 0 && r.forgot.join() === key && r.states.at(-1) === "idle");
}

// The ten-second cap: the edge ends the recording and the reader never tapped Stop. The form
// must leave "recording" all the same — a Stop button over a closed microphone does nothing.
console.log("createCloning: a recording the cap ends is a recording the form knows ended");
{
  const r = rig(tone(2));
  r.cloner.send({ kind: "make", name: "Capped", source: { kind: "microphone" } });
  r.cap();
  await settle();
  assert(
    "the cap moves the form off recording and the clone is kept, with no tap to stop",
    r.states.join(" | ") === "recording Capped | making Capped | idle: Saved Capped." && r.kept.join() === "Capped" && readClones(r.store).map((c) => c.name).join() === "Capped",
  );
}

console.log("createCloning: every way it fails is said on the form");
{
  const short = rig(tone(0.3));
  short.cloner.send({ kind: "make", name: "Blip", source: { kind: "file", file } });
  await settle();
  assert("a file too short to be a voice: not kept, the reason shown", short.states.at(-1)?.startsWith("idle: Could not make the voice: the recording is 0.3 s") === true && short.kept.length === 0);

  const held = new Map<string, string>();
  const full: PreferenceStore & { readonly keys: () => string[] } = { getItem: (k) => held.get(k) ?? null, setItem: () => undefined, removeItem: (k) => void held.delete(k), keys: () => [...held.keys()] };
  const refused = rig(tone(2), full);
  refused.cloner.send({ kind: "make", name: "Nowhere", source: { kind: "file", file } });
  await settle();
  assert("a store that refuses: not kept, the panel not told, the refusal shown", refused.states.at(-1) === `idle: Could not make the voice: ${REFUSED}` && refused.kept.length === 0);

  // A store that reads but will not write: the removal cannot land, so the clone is still
  // the device's and the panel must not be told to release its recording or drop the pick.
  const stuck = new Map<string, string>();
  let writable = true;
  const sticky: PreferenceStore & { readonly keys: () => string[] } = {
    getItem: (k) => stuck.get(k) ?? null,
    setItem: (k, v) => void (writable && stuck.set(k, v)),
    removeItem: (k) => void (writable && stuck.delete(k)),
    keys: () => [...stuck.keys()],
  };
  const standing = await cloneVoice("Standing", tone(2));
  writeClones(sticky, [standing]);
  writable = false;
  const forgetful = rig(tone(2), sticky);
  forgetful.cloner.send({ kind: "remove", key: standing.key });
  await settle();
  assert(
    "a store that will not take the removal: the clone is still kept, the panel not told, the refusal shown",
    readClones(sticky).map((c) => c.name).join() === "Standing" && forgetful.forgot.length === 0 && forgetful.states.at(-1) === `idle: ${REMOVAL_REFUSED}`,
  );

  const busy = rig(tone(2));
  busy.cloner.send({ kind: "make", name: "One", source: { kind: "microphone" } });
  busy.cloner.send({ kind: "make", name: "Two", source: { kind: "file", file } });
  await settle();
  assert("a second make while recording starts nothing, and the form says why", busy.states.join(" | ") === `recording One | recording One: ${BUSY}`);
  busy.cloner.dispose();
  assert("dispose stops a recording under way", busy.stops() === 1);
  await settle();
  assert("and nothing lands after it", busy.kept.length === 0 && busy.states.length === 2);
}

// The worker saying the model could not make a clone. It names a clone saved earlier, so it
// is SAID and nothing else: the arm exists because ending the making instead threw away the
// recording the reader had under way, without a word.
{
  const r = rig(tone(2));
  r.cloner.send({ kind: "make", name: "Mine", source: { kind: "microphone" } });
  await settle();
  r.cloner.send({ kind: "model-refused", name: "Older", message: "no prompt for this one" });
  assert(
    "the model refusing an older clone is said, and the recording under way survives it",
    r.states.at(-1) === "recording Mine: Older cannot be spoken on this device: no prompt for this one",
  );
  r.cloner.send({ kind: "stop" });
  await settle();
  assert("and that recording still becomes a clone the device keeps", r.kept.join() === "Mine");
}

const kept: ClonedVoice = await cloneVoice("t", tone(1));
writeClones(memoryPreferences(), [kept]);

console.log(process.exitCode ? "\nvoice-cloning-check: FAILED" : "\nvoice-cloning-check: all assertions passed");
