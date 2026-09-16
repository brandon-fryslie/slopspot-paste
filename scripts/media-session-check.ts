// The listen on the device's media controls (slopspot-read-along-a35.5). Run:
// `tsx scripts/media-session-check.ts`.
//
// [LAW:behavior-not-structure] What is asserted is what a lock screen does and shows: each
// control sends the reader's own gesture into the panel — the transport's verbs, nothing of
// its own — and does nothing when it would not do what it says; and the metadata and progress
// follow the panel's transport, the speaker changing with the passage under the voice. The
// session is a stub at exactly the seam mediaSession.ts declares.

import type { Gesture, Transport } from "../src/listenPanel";
import {
  ALBUM,
  createMediaSession,
  gestureOf,
  MEDIA_ACTIONS,
  metadataOf,
  positionOf,
  type ActionDetails,
  type MediaAction,
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

const drive = (unsupported: ReadonlyArray<MediaAction> = []) => {
  const session = new StubSession(unsupported);
  const sent: string[] = [];
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
  });
  return { session, sent, media };
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
  media.act("pause");
  assert("a pause from elsewhere — the element the platform paused — is answered the same way", sent.at(-1) === "tap play" && sent.length === 5);
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

console.log(process.exitCode === 1 ? "media-session-check: FAILED" : "media-session-check: ok");
