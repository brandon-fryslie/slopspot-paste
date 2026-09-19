// [LAW:decomposition] Voice cloning as the reader drives it: a recording or a file becomes a
// clone the device keeps, and a clone the reader is done with is forgotten. One sentence, no
// "and" — this module runs the making of clones. It records nothing itself (voiceCapture.ts
// is the edge), names no voice (clonedVoice.ts turns samples into one), draws nothing
// (voicePicker.ts) and picks nothing: the panel is told when a clone is kept or forgotten,
// and what it does with that — tell the worker, pick the new voice — is its own.
//
// A MACHINE AND A DRIVER, like the panel's: `step` is pure, every effect a value, so
// scripts/voice-cloning-check.ts walks every arm — a tap that stops before the microphone
// answers, a file too short to be a voice, a store that refuses — with no browser at all
// [LAW:effects-at-boundaries] [LAW:verifiable-goals].
//
// WHERE THE MAKING IS, AND WHAT WAS LAST SAID, ARE TWO FACTS. The phase is the reader's
// recording as it runs; the note is the last outcome, whoever it came from. They are
// separate fields because a word about ANOTHER voice — the model refusing a clone saved
// minutes ago, which arrives whenever the weights finish loading — must be sayable without
// touching a recording under way [LAW:types-are-the-program]. Fused, the only way to say
// anything was to end the making, which threw the reader's recording away mid-tap.
//
// ONE MAKING AT A TIME. A second record or upload while one is under way is refused as a
// value, not queued: the reader's tap on a busy form does nothing, and the note says why.

import { cloneVoice, readClones, withClone, withoutClone, writeClones, type ClonedVoice, type ClonedVoiceKey } from "./clonedVoice";
import type { PreferenceStore } from "./preferenceStore";
import type { Capture, VoiceCapture } from "./voiceCapture";

// [LAW:types-are-the-program] Where the making is: idle; recording, which the reader can
// stop; making, which they cannot — the decode and the hash are under way and end on their
// own.
export type CloningPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "recording"; readonly name: string }
  | { readonly kind: "making"; readonly name: string };

// The phase, and the last thing worth saying to the reader — null when nothing has been.
export interface CloningState {
  readonly phase: CloningPhase;
  readonly note: string | null;
}

export const initialCloning = (): CloningState => ({ phase: { kind: "idle" }, note: null });

export type Source = { readonly kind: "microphone" } | { readonly kind: "file"; readonly file: Blob };

export type CloningEvent =
  // The reader's tap: a recording from the microphone, or a file they chose, under a name.
  | { readonly kind: "make"; readonly name: string; readonly source: Source }
  // The reader's tap on a recording under way: it ends, and what was recorded is made.
  | { readonly kind: "stop" }
  // The capture answered: the samples became a clone, or the reason they did not.
  | { readonly kind: "made"; readonly voice: ClonedVoice }
  | { readonly kind: "failed"; readonly message: string }
  // The model could not make a prompt of a clone the device keeps (synthesisProtocol.ts
  // `clone-failed`). It names ANOTHER making than the one under way, so it is said and
  // nothing else: the phase is not the model's to move.
  | { readonly kind: "model-refused"; readonly name: string; readonly message: string }
  // The store answered `keep`.
  | { readonly kind: "kept"; readonly voice: ClonedVoice }
  // The reader is done with a clone.
  | { readonly kind: "remove"; readonly key: ClonedVoiceKey };

export type CloningEffect =
  | { readonly kind: "capture"; readonly source: Source; readonly name: string }
  | { readonly kind: "stop" }
  | { readonly kind: "keep"; readonly voice: ClonedVoice }
  | { readonly kind: "forget"; readonly key: ClonedVoiceKey };

export interface CloningStep {
  readonly state: CloningState;
  readonly effects: ReadonlyArray<CloningEffect>;
}

const stay = (state: CloningState): CloningStep => ({ state, effects: [] });
// Said, wherever the making is.
const noting = (state: CloningState, note: string): CloningStep => ({ state: { ...state, note }, effects: [] });
// The making is over, and this is what came of it.
const ended = (note: string): CloningStep => ({ state: { phase: { kind: "idle" }, note }, effects: [] });

export const BUSY = "One voice at a time: wait for the one being made.";

// [LAW:dataflow-not-control-flow] One row per event, total over the state.
export const step = (state: CloningState, event: CloningEvent): CloningStep => {
  switch (event.kind) {
    case "make":
      if (state.phase.kind !== "idle") return noting(state, BUSY);
      return {
        state: {
          phase: event.source.kind === "microphone" ? { kind: "recording", name: event.name } : { kind: "making", name: event.name },
          note: null,
        },
        effects: [{ kind: "capture", source: event.source, name: event.name }],
      };
    case "stop":
      return state.phase.kind === "recording"
        ? { state: { phase: { kind: "making", name: state.phase.name }, note: state.note }, effects: [{ kind: "stop" }] }
        : stay(state);
    case "made":
      // [LAW:no-silent-failure] Kept wherever the phase is. The samples are recorded,
      // decoded and hashed by the time this arrives; discarding them because the phase
      // moved would throw away the one thing the reader asked for, without a word.
      return { state, effects: [{ kind: "keep", voice: event.voice }] };
    case "failed":
      return ended(`Could not make the voice: ${event.message}`);
    case "model-refused":
      return noting(state, `${event.name} cannot be spoken on this device: ${event.message}`);
    case "kept":
      return ended(`Saved ${event.voice.name}.`);
    case "remove":
      return { state, effects: [{ kind: "forget", key: event.key }] };
  }
};

// ── the driver ──────────────────────────────────────────────────────────────────────

export interface CloningConfig {
  readonly store: PreferenceStore;
  readonly capture: VoiceCapture;
  readonly onChange: (state: CloningState) => void;
  // A clone the device now keeps, and one it no longer does: the panel's cue to tell the
  // worker and to pick.
  readonly onKept: (voice: ClonedVoice) => void;
  readonly onForgot: (key: ClonedVoiceKey) => void;
}

export interface Cloning {
  readonly send: (event: CloningEvent) => void;
  readonly state: () => CloningState;
  readonly dispose: () => void;
}

export const REFUSED = "this browser refused to keep it; its storage for this site may be full";

export const createCloning = (config: CloningConfig): Cloning => {
  // [LAW:no-shared-mutable-globals] Owned here; written only by `dispatch`, from `step`.
  let state = initialCloning();
  let capture: Capture | null = null;
  let disposed = false;
  const queue: CloningEvent[] = [];
  let draining = false;

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  const perform = (effect: CloningEffect): void => {
    switch (effect.kind) {
      case "capture": {
        const started = effect.source.kind === "microphone" ? config.capture.record() : { pcm: config.capture.decode(effect.source.file), stop: () => undefined };
        capture = started;
        void started.pcm
          .then((pcm) => cloneVoice(effect.name, pcm))
          .then(
            (voice) => dispatch({ kind: "made", voice }),
            (e: unknown) => dispatch({ kind: "failed", message: message(e) }),
          );
        return;
      }
      case "stop":
        capture?.stop();
        return;
      case "keep": {
        const saving = writeClones(config.store, withClone(readClones(config.store), effect.voice));
        if (saving.kind === "kept") {
          dispatch({ kind: "kept", voice: effect.voice });
          config.onKept(effect.voice);
        } else {
          dispatch({ kind: "failed", message: REFUSED });
        }
        return;
      }
      case "forget": {
        // A refused removal is a store that will not write at all, which the read edge
        // already reads as nothing: nothing to say beyond the console.
        const saving = writeClones(config.store, withoutClone(readClones(config.store), effect.key));
        if (saving.kind === "refused") console.warn(`voice cloning: the browser refused to forget ${effect.key}`);
        config.onForgot(effect.key);
        return;
      }
    }
  };

  const dispatch = (event: CloningEvent): void => {
    if (disposed) return;
    queue.push(event);
    if (draining) return;
    draining = true;
    try {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const before = state;
        const planned = step(state, next);
        state = planned.state;
        for (const effect of planned.effects) perform(effect);
        if (state !== before) config.onChange(state);
      }
    } finally {
      draining = false;
    }
  };

  return {
    send: dispatch,
    state: () => state,
    dispose: () => {
      disposed = true;
      capture?.stop();
    },
  };
};
