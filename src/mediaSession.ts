// [LAW:decomposition] The listen as the device's media controls see it: the lock screen, the
// notification shade, a headset's buttons. One sentence, no "and" hiding a second job: this
// module presents the Listen panel's transport to the platform as media. It sounds nothing and
// owns no position; what it shows is the panel's transport reading, and what it does is send
// the panel the reader's own gestures (listenPanel.ts), so a lock-screen button is one more
// door into the one transport, exactly as a key is (shortcuts.ts) [LAW:one-type-per-behavior].
//
// [LAW:one-source-of-truth] Position is the player's. The session is told it at every
// discontinuity the panel reports — a play, a pause, a seek, a passage boundary — with the
// speed it runs at, which is how the platform itself extrapolates the lock screen's progress
// bar between reports; nothing here keeps a time of its own or ticks one.
//
// WHAT IT SHOWS. The paste's title, the speaker of the passage the voice is in as the
// "artist" — so the lock screen says who is talking — and the site as the album. No artwork:
// the site's one icon is an SVG, which the platforms' media controls do not all draw. While
// nothing is on stage the session says `none` and shows nothing.
//
// WHY A CARRIER. The platform gives its controls, and the pause a call makes, to a media
// element, not to the AudioContext the voice sounds from — and only to one playing something
// long enough to be content. Chrome counts an element playing a MediaStream as a one-shot
// sound nobody controls (WebMediaPlayerMS reports kOneShot, and MediaSessionImpl::
// IsControllable is false for a session with only those), and a file of five seconds or less
// as transient (media::DurationToMediaContentType). So an element loops a silent file of
// CARRIER_SECONDS while the transport says the listen is playing — a stall included, whose
// controls offer Pause, and which a phone must keep in the foreground while its audio is made
// — and is paused otherwise, so a voice standing ready or paused holds none of the phone's
// audio. It is never a clock and carries no sound [LAW:one-source-of-truth].
//
// THE UNLOCK. Where a browser asks for a gesture per element, the element's play when the
// voice first sounds — on a worker message, long after the tap — would be refused. So the
// panel's unlock, on the tap's stack, primes it: made, played and paused at once, before it has
// loaded a byte, which takes no audio focus and shows no notification. A pause the element
// did not get from here — a call, another app's audio, headphones pulled out — is answered as
// the controls' own Pause [LAW:no-silent-failure]; a play it refuses is said (`refused`), and
// the voice sounds on without the lock screen.
//
// WHAT IT ANSWERS. Play and pause are the transport's one Play tap, sent only when it would
// do what was asked — a play over a playing voice is nothing, not a pause. Stop is Stop. The
// seeks are the scrubber and the nudges; previous and next track are the turn skips, the
// lock screen's two big arrows moving by speaker as the mini-player's do.

import type { Gesture, Playback, Transport } from "./listenPanel";
import { NUDGE_SECONDS } from "./shortcuts";

// ── the reading ───────────────────────────────────────────────────────────────────────

export interface Metadata {
  readonly title: string;
  readonly artist: string;
  readonly album: string;
}

// The session's position state, in the platform's seconds.
export interface Position {
  readonly duration: number;
  readonly position: number;
  readonly playbackRate: number;
}

export const ALBUM = "slopspot";

// What the controls show for this reading: nothing while no voice is on stage; otherwise the
// paste, and the speaker of the passage under the voice, or none between passages.
export const metadataOf = (transport: Transport, title: string, speakerOf: (utterance: number) => string): Metadata | null =>
  transport.playback === "none" ? null : { title, artist: transport.utterance === null ? "" : speakerOf(transport.utterance), album: ALBUM };

// Where the progress bar is: none while no voice is on stage or the clock has no length; the
// position is clamped to the duration, which the platform requires and an estimated clock
// can briefly overrun.
export const positionOf = (transport: Transport): Position | null =>
  transport.playback === "none" || !(transport.totalMs > 0)
    ? null
    : { duration: transport.totalMs / 1000, position: Math.min(Math.max(transport.atMs, 0), transport.totalMs) / 1000, playbackRate: transport.speed };

// ── the actions ───────────────────────────────────────────────────────────────────────

export const MEDIA_ACTIONS = ["play", "pause", "stop", "seekbackward", "seekforward", "seekto", "previoustrack", "nexttrack"] as const;
export type MediaAction = (typeof MEDIA_ACTIONS)[number];

// The details a handler is called with that this module reads: where a `seekto` lands, and
// how far a `seekbackward` or `seekforward` goes when the platform says.
export interface ActionDetails {
  readonly seekTime?: number;
  readonly seekOffset?: number;
}

// [LAW:single-enforcer] The one translation of a control's action into the reader's gesture,
// or null when the action would do nothing: a play over a voice already sounding, a pause
// over one that is not, a seek to nowhere.
export const gestureOf = (action: MediaAction, details: ActionDetails, playback: Playback): Gesture | null => {
  switch (action) {
    case "play":
      return playback === "playing" ? null : { kind: "tap", control: "play" };
    case "pause":
      return playback === "playing" ? { kind: "tap", control: "play" } : null;
    case "stop":
      return playback === "none" ? null : { kind: "tap", control: "stop" };
    case "seekbackward":
      return { kind: "nudge", bySeconds: -(details.seekOffset ?? NUDGE_SECONDS) };
    case "seekforward":
      return { kind: "nudge", bySeconds: details.seekOffset ?? NUDGE_SECONDS };
    case "seekto":
      return details.seekTime === undefined || !Number.isFinite(details.seekTime) ? null : { kind: "scrub", toMs: Math.max(details.seekTime, 0) * 1000 };
    case "previoustrack":
      return { kind: "turn", by: -1 };
    case "nexttrack":
      return { kind: "turn", by: 1 };
  }
};

// ── the carrier ───────────────────────────────────────────────────────────────────────

// Longer than the five seconds under which Chrome counts a file as a transient sound.
export const CARRIER_SECONDS = 10;
const CARRIER_RATE = 8000;

// The carrier: CARRIER_SECONDS of silence as an 8-bit mono PCM WAV, 80 KB, built here rather
// than fetched, so the lock screen needs nothing from the network.
export const carrierWav = (): ArrayBuffer => {
  const samples = CARRIER_SECONDS * CARRIER_RATE;
  const bytes = new ArrayBuffer(44 + samples);
  const view = new DataView(bytes);
  const tag = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, CARRIER_RATE, true);
  view.setUint32(28, CARRIER_RATE, true); // bytes per second
  view.setUint16(32, 1, true); // bytes per frame
  view.setUint16(34, 8, true); // bits per sample
  tag(36, "data");
  view.setUint32(40, samples, true);
  // Unsigned 8-bit silence is the midpoint.
  new Uint8Array(bytes, 44).fill(128);
  return bytes;
};

// [LAW:types-are-the-program] Exactly the surface of HTMLMediaElement used here.
export interface MediaElement {
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: "pause", listener: () => void): void;
}

const aborted = (error: unknown): boolean => typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";

// ── the driver ────────────────────────────────────────────────────────────────────────

// [LAW:types-are-the-program] Exactly the surface of `navigator.mediaSession` used here, so
// the page's satisfies it structurally and the check's stub implements nothing more.
export interface SessionSeam {
  playbackState: Playback;
  metadata: unknown;
  setActionHandler(action: MediaAction, handler: (details: ActionDetails) => void): void;
  setPositionState(state?: Position): void;
}

export interface MediaSessionConfig {
  readonly session: SessionSeam;
  // `new MediaMetadata(...)` in the page.
  readonly metadata: (metadata: Metadata) => unknown;
  readonly title: string;
  // The name the page shows on a passage's turn card.
  readonly speakerOf: (utterance: number) => string;
  // The panel's one door.
  readonly send: (gesture: Gesture) => void;
  // A fresh element looping the carrier (`carrierWav`): `new Audio(url)` with `loop` set.
  readonly element: () => MediaElement;
  // The carrier's play was refused: the voice sounds without the lock screen.
  readonly refused: (error: unknown) => void;
}

export interface MediaSession {
  // The panel's transport, at every discontinuity.
  readonly show: (transport: Transport) => void;
  // The reader's gesture, on its stack: the carrier primed for a play without one.
  readonly unlock: () => void;
}

const sameMetadata = (a: Metadata | null, b: Metadata | null): boolean =>
  a === b || (a !== null && b !== null && a.title === b.title && a.artist === b.artist && a.album === b.album);

export const createMediaSession = (config: MediaSessionConfig): MediaSession => {
  const { session } = config;
  // [LAW:no-shared-mutable-globals] Owned here: the last reading shown, which a handler
  // decides against and a repeated reading is compared with, so the platform is not handed the
  // same metadata again — a reassignment restarts the controls' artwork fetch; the carrier,
  // made on first need; and how many of its pause events are this module's own.
  let playback: Playback = "none";
  let shown: Metadata | null = null;
  let carrier: MediaElement | null = null;
  let ownPauses = 0;

  const act = (action: MediaAction, details: ActionDetails = {}): void => {
    const gesture = gestureOf(action, details, playback);
    if (gesture !== null) config.send(gesture);
  };

  // [LAW:no-silent-failure] exception: a browser that does not support an action throws on
  // its registration. That control is simply not offered on that device — every other one
  // still is, and the page's own transport has all of them.
  for (const action of MEDIA_ACTIONS) {
    try {
      session.setActionHandler(action, (details) => act(action, details));
    } catch {
      /* unsupported here: the platform does not show this control */
    }
  }

  const made = (): MediaElement => {
    if (carrier !== null) return carrier;
    const element = config.element();
    element.addEventListener("pause", () => {
      if (ownPauses > 0) ownPauses -= 1;
      else act("pause");
    });
    carrier = element;
    return element;
  };
  // A play cut short by a pause from here — the prime's, or one landing before the file
  // loaded — is not a refusal.
  const play = (element: MediaElement): void => {
    element.play().catch((error: unknown) => {
      if (!aborted(error)) config.refused(error);
    });
  };
  const pause = (element: MediaElement): void => {
    if (element.paused) return;
    ownPauses += 1;
    element.pause();
  };

  const unlock = (): void => {
    if (carrier !== null) return;
    const element = made();
    play(element);
    pause(element);
  };

  const show = (transport: Transport): void => {
    const was = playback;
    playback = transport.playback;
    const metadata = metadataOf(transport, config.title, config.speakerOf);
    if (!sameMetadata(metadata, shown)) {
      shown = metadata;
      session.metadata = metadata === null ? null : config.metadata(metadata);
    }
    session.playbackState = transport.playback;
    const position = positionOf(transport);
    if (position === null) session.setPositionState();
    else session.setPositionState(position);
    // The carrier follows the reading: played as the listen starts playing, and paused while
    // it is not. A play is asked once per start, so a refusal is said once, not on every
    // reading; a carrier never needed is never made.
    if (transport.playback === "playing") {
      if (was !== "playing") play(made());
    } else if (carrier !== null) {
      pause(carrier);
    }
  };

  // The handlers stay for the page's life: the panel's own teardown reports `none`, which is
  // what clears the controls and pauses the carrier, and a page restored from the cache is
  // heard again at once.
  return { show, unlock };
};
