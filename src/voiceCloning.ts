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
// ONE MAKING AT A TIME. A second record or upload while one is under way is refused as a
// value, not queued: the reader's tap on a busy form does nothing, and the form says why.

import { cloneVoice, readClones, withClone, withoutClone, writeClones, type ClonedVoice, type ClonedVoiceKey } from "./clonedVoice";
import type { PreferenceStore } from "./preferenceStore";
import type { Capture, VoiceCapture } from "./voiceCapture";

// [LAW:types-are-the-program] Where the making is: idle with the last outcome's note, if any;
// recording, which the reader can stop; making, which they cannot — the decode and the hash
// are under way and end on their own.
export type CloningState =
  | { readonly kind: "idle"; readonly note: string | null }
  | { readonly kind: "recording"; readonly name: string }
  | { readonly kind: "making"; readonly name: string };

export const initialCloning = (): CloningState => ({ kind: "idle", note: null });

export type Source = { readonly kind: "microphone" } | { readonly kind: "file"; readonly file: Blob };

export type CloningEvent =
  // The reader's tap: a recording from the microphone, or a file they chose, under a name.
  | { readonly kind: "make"; readonly name: string; readonly source: Source }
  // The reader's tap on a recording under way: it ends, and what was recorded is made.
  | { readonly kind: "stop" }
  // The capture answered: the samples became a clone, or the reason they did not.
  | { readonly kind: "made"; readonly voice: ClonedVoice }
  | { readonly kind: "failed"; readonly message: string }
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
const idle = (note: string | null): CloningStep => ({ state: { kind: "idle", note }, effects: [] });

export const BUSY = "One voice at a time: wait for the one being made.";

// [LAW:dataflow-not-control-flow] One row per event, total over the state.
export const step = (state: CloningState, event: CloningEvent): CloningStep => {
  switch (event.kind) {
    case "make":
      if (state.kind !== "idle") return stay(state);
      return {
        state: event.source.kind === "microphone" ? { kind: "recording", name: event.name } : { kind: "making", name: event.name },
        effects: [{ kind: "capture", source: event.source, name: event.name }],
      };
    case "stop":
      return state.kind === "recording" ? { state: { kind: "making", name: state.name }, effects: [{ kind: "stop" }] } : stay(state);
    case "made":
      return state.kind === "idle" ? stay(state) : { state, effects: [{ kind: "keep", voice: event.voice }] };
    case "failed":
      return idle(`Could not make the voice: ${event.message}`);
    case "kept":
      return idle(`Saved ${event.voice.name}.`);
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
