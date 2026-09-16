// The listen on the device's media controls (slopspot-read-along-a35.5). Run:
// `tsx scripts/media-session-check.ts`.
//
// [LAW:behavior-not-structure] What is asserted is what a lock screen does and shows: each
// control sends the reader's own gesture into the panel — the transport's verbs, nothing of
// its own — and does nothing when it would not do what it says; the metadata and progress
// follow the panel's transport, the speaker changing with the passage under the voice; and the
// carrier that makes the page the platform's media plays exactly while the listen does, is
// primed by an unlock without sounding or being made twice, answers a pause it did not make as
// the controls' Pause, and is a silent file long enough to count as media. The session and the
// element are stubs at exactly the seams mediaSession.ts declares.

import type { Gesture, Transport } from "../src/listenPanel";
import {
  ALBUM,
  CARRIER_SECONDS,
  carrierWav,
  createMediaSession,
  gestureOf,
  MEDIA_ACTIONS,
  metadataOf,
  positionOf,
  type ActionDetails,
  type MediaAction,
  type MediaElement,
  type Metadata,
  type Position,
  type SessionSeam,
} from "../src/mediaSession";
import { NUDGE_SECONDS } from "../src/shortcuts";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const said = (gesture: Gesture | null): string => {
  if (gesture === null) return "nothing";
  switch (gesture.kind) {
    case "tap":
      return `tap ${gesture.control}`;
    case "nudge":
      return `nudge ${gesture.bySeconds}`;
    case "scrub":
      return `scrub ${gesture.toMs}`;
    case "turn":
      return `turn ${gesture.by}`;
    case "place":
      return `place ${gesture.to.utterance}:${gesture.to.char}`;
    case "speed":
      return `speed ${gesture.by}`;
  }
};

const TITLE = "Why does the parser stall?";
const SPEAKERS = ["You", "Claude", "You"];
const speakerOf = (utterance: number): string => SPEAKERS[utterance] ?? "";
const transport = (over: Partial<Transport> = {}): Transport => ({ playback: "playing", atMs: 12_500, totalMs: 90_000, speed: 1, utterance: 1, ...over });

// ── the actions ───────────────────────────────────────────────────────────────────────

console.log("gestureOf: each control is one of the reader's own gestures, or nothing");
{
  assert("play over a paused voice, or none on stage, is the transport's Play tap", said(gestureOf("play", {}, "paused")) === "tap play" && said(gestureOf("play", {}, "none")) === "tap play");
  assert("play over a voice already playing is nothing — never a pause", said(gestureOf("play", {}, "playing")) === "nothing");
  assert("pause over a playing voice is the Play tap; over anything else, nothing", said(gestureOf("pause", {}, "playing")) === "tap play" && said(gestureOf("pause", {}, "paused")) === "nothing" && said(gestureOf("pause", {}, "none")) === "nothing");
  assert("stop is Stop, while there is anything to stop", said(gestureOf("stop", {}, "paused")) === "tap stop" && said(gestureOf("stop", {}, "none")) === "nothing");
  assert("the seek buttons are the nudges: the platform's offset when it says one, the keys' ten seconds when not", said(gestureOf("seekbackward", {}, "playing")) === `nudge -${NUDGE_SECONDS}` && said(gestureOf("seekforward", { seekOffset: 30 }, "playing")) === "nudge 30");
  assert("a drag on the lock screen's bar is the scrubber, in milliseconds", said(gestureOf("seekto", { seekTime: 42.5 }, "paused")) === "scrub 42500");
  assert("a seekto with no time, or no finite one, names nowhere", said(gestureOf("seekto", {}, "playing")) === "nothing" && said(gestureOf("seekto", { seekTime: Number.NaN }, "playing")) === "nothing");
  assert("previous and next track are the turn skips", said(gestureOf("previoustrack", {}, "playing")) === "turn -1" && said(gestureOf("nexttrack", {}, "paused")) === "turn 1");
}

// ── the reading ───────────────────────────────────────────────────────────────────────

console.log("metadataOf and positionOf: the controls show the paste, who is speaking, and where");
{
  assert("nothing on stage: nothing shown", metadataOf(transport({ playback: "none" }), TITLE, speakerOf) === null && positionOf(transport({ playback: "none" })) === null);
  const shown = metadataOf(transport(), TITLE, speakerOf);
  assert("the paste's title, the speaker of the passage under the voice, the site", shown?.title === TITLE && shown.artist === "Claude" && shown.album === ALBUM);
  assert("the speaker follows the passage", metadataOf(transport({ utterance: 2 }), TITLE, speakerOf)?.artist === "You");
  const position = positionOf(transport({ speed: 1.5 }));
  assert("the progress in seconds, at the speed the voice reads", position?.duration === 90 && position.position === 12.5 && position.playbackRate === 1.5);
  assert("an estimated clock overrun by the voice is clamped to its length", positionOf(transport({ atMs: 95_000 }))?.position === 90);
  assert("a clock with no length yet has no progress to show", positionOf(transport({ totalMs: 0, atMs: 0 })) === null);
}

// ── the driver ────────────────────────────────────────────────────────────────────────

class StubSession implements SessionSeam {
  playbackState: "none" | "paused" | "playing" = "none";
  metadata: unknown = null;
  readonly handlers = new Map<MediaAction, (details: ActionDetails) => void>();
  readonly positions: Array<Position | undefined> = [];
  metadataSets = 0;
  readonly unsupported: ReadonlySet<MediaAction>;
  constructor(unsupported: ReadonlyArray<MediaAction> = []) {
    this.unsupported = new Set(unsupported);
  }
  setActionHandler(action: MediaAction, handler: (details: ActionDetails) => void): void {
    if (this.unsupported.has(action)) throw new TypeError(`${action} is not a valid enum value`);
    this.handlers.set(action, handler);
  }
  setPositionState(state?: Position): void {
    this.positions.push(state);
  }
  press(action: MediaAction, details: ActionDetails = {}): void {
    const handler = this.handlers.get(action);
    if (handler === undefined) throw new Error(`stub session: no handler for ${action}`);
    handler(details);
  }
}

// An element whose plays are answered as the check says; a pause fires its event a task
// later, as a browser's does, and a pause before a play has settled rejects that play as
// aborted, as a browser's does.
class StubElement implements MediaElement {
  paused = true;
  answer: "plays" | "refuses" = "plays";
  readonly calls: string[] = [];
  readonly #listeners: Array<() => void> = [];
  #pending: ((error: Error) => void) | null = null;
  play(): Promise<void> {
    this.calls.push("play");
    if (this.answer === "refuses") return Promise.reject(Object.assign(new Error("NotAllowedError"), { name: "NotAllowedError" }));
    this.paused = false;
    return new Promise((resolve, reject) => {
      this.#pending = reject;
      setTimeout(() => {
        if (this.#pending === reject) resolve();
        this.#pending = null;
      }, 1);
    });
  }
  pause(): void {
    this.calls.push("pause");
    if (this.paused) return;
    this.paused = true;
    this.#pending?.(Object.assign(new Error("AbortError"), { name: "AbortError" }));
    this.#pending = null;
    setTimeout(() => this.#fire(), 0);
  }
  // The platform pausing the element on its own.
  platformPause(): void {
    this.paused = true;
    setTimeout(() => this.#fire(), 0);
  }
  addEventListener(_type: "pause", listener: () => void): void {
    this.#listeners.push(listener);
  }
  #fire(): void {
    for (const listener of this.#listeners) listener();
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

const drive = (unsupported: ReadonlyArray<MediaAction> = []) => {
  const session = new StubSession(unsupported);
  const sent: string[] = [];
  const elements: StubElement[] = [];
  const refused: unknown[] = [];
  const media = createMediaSession({
    session: new Proxy(session, {
      set(target, key, value) {
        if (key === "metadata") target.metadataSets += 1;
        return Reflect.set(target, key, value);
      },
    }),
    metadata: (shown: Metadata) => ({ built: shown }),
    title: TITLE,
    speakerOf,
    send: (gesture) => sent.push(said(gesture)),
    element: () => {
      const element = new StubElement();
      elements.push(element);
      return element;
    },
    refused: (error) => refused.push(error),
  });
  return { session, sent, media, elements, refused };
};

console.log("createMediaSession: every control is offered, and each sends the panel the reader's gesture");
{
  const { session, sent, media } = drive();
  assert("every action has a handler", MEDIA_ACTIONS.every((action) => session.handlers.has(action)));
  media.show(transport({ playback: "paused" }));
  session.press("play");
  media.show(transport());
  session.press("play");
  session.press("pause");
  session.press("seekto", { seekTime: 30 });
  session.press("nexttrack");
  assert("each press decides against the transport last shown: play from paused, nothing over playing, then pause, the bar, the next turn", sent.join() === "tap play,tap play,scrub 30000,turn 1");
}

console.log("createMediaSession: what the controls show follows the transport");
{
  const { session, media } = drive();
  media.show(transport({ utterance: 0 }));
  const first = session.metadata as { built: Metadata };
  assert("playing: the state, the metadata built from the reading, the position", session.playbackState === "playing" && first.built.artist === "You" && session.positions.at(-1)?.position === 12.5);
  media.show(transport({ utterance: 0, atMs: 14_000 }));
  assert("the same speaker again: the metadata is not handed over again, the position is", session.metadataSets === 1 && session.positions.at(-1)?.position === 14);
  media.show(transport({ utterance: 1, atMs: 20_000, playback: "paused" }));
  assert("the next passage, paused: the new speaker, the paused state", session.metadataSets === 2 && (session.metadata as { built: Metadata }).built.artist === "Claude" && session.playbackState === "paused");
  media.show(transport({ playback: "none", atMs: 0, utterance: null }));
  assert("nothing on stage: the metadata cleared, the state none, the position cleared", session.metadata === null && session.playbackState === "none" && session.positions.at(-1) === undefined);
}

console.log("createMediaSession: a control the browser does not support is not offered, and the rest still are");
{
  const { session } = drive(["seekto", "stop"]);
  assert("the unsupported two are absent, every other handler is set", !session.handlers.has("seekto") && !session.handlers.has("stop") && session.handlers.size === MEDIA_ACTIONS.length - 2);
}

console.log("createMediaSession: the carrier plays exactly while the listen does");
{
  const { media, elements, refused } = drive();
  media.show(transport({ playback: "none" }));
  media.show(transport({ playback: "paused" }));
  assert("nothing playing yet: no carrier is made", elements.length === 0);
  media.show(transport());
  const carrier = elements[0];
  if (carrier === undefined) throw new Error("fixture: no carrier made");
  assert("the listen plays: the carrier is made and played", elements.length === 1 && carrier.calls.join() === "play" && !carrier.paused);
  media.show(transport({ atMs: 14_000 }));
  assert("a later reading of the same playing listen asks nothing more of it", carrier.calls.join() === "play");
  media.show(transport({ playback: "paused" }));
  assert("paused: the carrier is paused", carrier.calls.join() === "play,pause" && carrier.paused);
  await tick();
  assert("its play cut short by that pause is no refusal", refused.length === 0);
  media.show(transport({ playback: "none" }));
  assert("stopped over a paused carrier: nothing more asked of it", carrier.calls.join() === "play,pause");
}

console.log("createMediaSession: the carrier's own pause, landing after the listen plays again, is not the controls' Pause");
{
  const { media, elements, sent } = drive();
  media.show(transport());
  await tick();
  media.show(transport({ playback: "paused" }));
  media.show(transport());
  await tick();
  assert("a quick Pause then Play: the pause event from here lands while playing, and nothing is sent", sent.length === 0 && elements[0]?.paused === false);
}

console.log("createMediaSession: an unlock primes the carrier once, sounding nothing");
{
  const { media, elements, refused, sent } = drive();
  media.unlock();
  const carrier = elements[0];
  if (carrier === undefined) throw new Error("fixture: no carrier made");
  assert("the carrier is made, played and paused on the caller's stack", carrier.calls.join() === "play,pause" && carrier.paused);
  await tick();
  assert("the prime is neither a refusal nor a pause to answer", refused.length === 0 && sent.length === 0);
  media.unlock();
  assert("a second unlock leaves the carrier alone: a loaded element's play would take the phone's audio", elements.length === 1 && carrier.calls.join() === "play,pause");
  media.show(transport());
  assert("the listen plays: that same carrier plays", elements.length === 1 && carrier.calls.join() === "play,pause,play" && !carrier.paused);
}

console.log("createMediaSession: a pause the carrier did not get from here is the controls' Pause; a refused play is said once per start");
{
  const { media, elements, refused, sent } = drive();
  media.show(transport());
  const carrier = elements[0];
  if (carrier === undefined) throw new Error("fixture: no carrier made");
  await tick();
  carrier.platformPause();
  await tick();
  assert("the platform pauses it mid-listen: the panel is sent the Play tap that pauses", sent.join() === "tap play");
  media.show(transport({ playback: "paused" }));
  await tick();
  assert("the pause that follows asks nothing of a paused carrier, and nothing more is sent", sent.length === 1 && carrier.calls.join() === "play");
  carrier.answer = "refuses";
  media.show(transport());
  media.show(transport({ atMs: 13_000 }));
  media.show(transport({ atMs: 13_500 }));
  await tick();
  assert("refused: said once, not asked again while the listen plays on", refused.length === 1 && carrier.calls.filter((c) => c === "play").length === 2);
  media.show(transport({ playback: "paused" }));
  carrier.answer = "plays";
  media.show(transport());
  assert("the next start asks again, and plays", carrier.calls.filter((c) => c === "play").length === 3 && !carrier.paused);
}

console.log("carrierWav: a silent PCM file longer than the five seconds under which Chrome counts a sound as transient");
{
  const wav = carrierWav();
  const view = new DataView(wav);
  const text = (at: number, length: number): string => String.fromCharCode(...new Uint8Array(wav, at, length));
  const bytesPerSecond = view.getUint32(28, true);
  const dataBytes = view.getUint32(40, true);
  assert("a RIFF WAVE of PCM, mono, 8-bit", text(0, 4) === "RIFF" && view.getUint32(4, true) === wav.byteLength - 8 && text(8, 4) === "WAVE" && text(12, 4) === "fmt " && view.getUint16(20, true) === 1 && view.getUint16(22, true) === 1 && view.getUint16(34, true) === 8 && text(36, 4) === "data" && dataBytes === wav.byteLength - 44);
  assert("its length is CARRIER_SECONDS, more than five", dataBytes / bytesPerSecond === CARRIER_SECONDS && CARRIER_SECONDS > 5 && view.getUint32(24, true) === bytesPerSecond);
  assert("every sample is silence", new Uint8Array(wav, 44).every((sample) => sample === 128));
  // The page's <audio> must fit the seam; the proof the wiring rests on, where the DOM lib is.
  type RealElementFits = HTMLAudioElement extends MediaElement ? true : never;
  const realElementFits: RealElementFits = true;
  assert("HTMLAudioElement satisfies the carrier's seam", realElementFits);
}

console.log(process.exitCode === 1 ? "media-session-check: FAILED" : "media-session-check: ok");
