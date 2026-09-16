// [LAW:decomposition] The listen as the device's media controls see it: the lock screen, the
// notification shade, a headset's buttons. One sentence, no "and" hiding a second job: this
// module translates between the Media Session API and the Listen panel. It plays nothing and
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
}

export interface MediaSession {
  // The panel's transport, at every discontinuity.
  readonly show: (transport: Transport) => void;
  // An action from somewhere other than the session's own handlers — the media element
  // paused by the platform — answered the same way.
  readonly act: (action: MediaAction) => void;
}

const sameMetadata = (a: Metadata | null, b: Metadata | null): boolean =>
  a === b || (a !== null && b !== null && a.title === b.title && a.artist === b.artist && a.album === b.album);

export const createMediaSession = (config: MediaSessionConfig): MediaSession => {
  const { session } = config;
  // [LAW:no-shared-mutable-globals] The last reading shown, owned here: what a handler
  // decides against, and what a repeated reading is compared with so the platform is not
  // handed the same metadata again — a reassignment restarts the controls' artwork fetch.
  let playback: Playback = "none";
  let shown: Metadata | null = null;

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

  const show = (transport: Transport): void => {
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
  };

  // The handlers stay for the page's life: the panel's own teardown reports `none`, which is
  // what clears the controls, and a page restored from the cache is heard again at once.
  return { show, act: (action) => act(action) };
};
