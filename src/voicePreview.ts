// [LAW:decomposition] The voice preview: one short fixed phrase, synthesized in a voice the
// reader is considering and played at once. One sentence, no "and": this module hears one
// voice out. It decides nothing about the script (scheduler.ts), owns no picker (the panel
// drives it from the picker's taps) and never touches the listen's player: a preview plays
// through a player of its own on a device of its own, so a preview and the reading never
// share a schedule or a suspend.
//
// ONE UNIT, ONE PLAYER PER PREVIEW. The unit player speaks scripts, and a preview is a
// script of one unit: unit 0 of a one-unit player built for it, delivered from a synthesize
// request the page ids below zero (synthesisProtocol.ts) so the scheduler, which hears the
// same port, knows the frames are not its script's. Each preview takes a fresh id, counted
// down in the state, and its player answers to that id, so a frame or a report of a preview
// the reader has already replaced is told from the current one by its id alone — nothing
// is timed, nothing is flagged [LAW:types-are-the-program] [LAW:no-ambient-temporal-coupling].
// A player lives exactly while its preview sounds: the driver ends every player whose id
// the state no longer names, after every step and BEFORE the step's commands — a player's
// end suspends the device, and the command that follows a replacement is the new
// player's play, which resumes it; the other order would suspend the phrase just started.
//
// [LAW:effects-at-boundaries] `step` is pure over the state and an event and returns the
// commands for the two seams; `createPreviewer` performs them. scripts/voice-preview-
// check.ts drives the step with no device at all, and the driver over the stub one.

import type { VoiceId } from "./modelAssets";
import type { SynthesisPort } from "./synthesisClient";
import type { FromWorker, ToWorker } from "./synthesisProtocol";
import { createUnitPlayer, openDevice, type DeviceFactory, type OpenDevice, type PlayerEvent, type PlayerState, type UnitPlayer } from "./unitPlayer";
import { previewText } from "./voiceChoice";

// ── state ──────────────────────────────────────────────────────────────────────────────

export interface Sounding {
  readonly voice: VoiceId;
  readonly unitId: number;
}

export interface PreviewState {
  readonly sounding: Sounding | null;
  // The id the next preview takes: -1 for the first, one lower for each after.
  readonly next: number;
}

export const initialState = (): PreviewState => ({ sounding: null, next: -1 });

export type PreviewEvent =
  // The reader's tap on a voice: it is heard now, replacing whatever was sounding.
  | { readonly kind: "say"; readonly voice: VoiceId }
  // Silence: the preview under way, if any, is withdrawn.
  | { readonly kind: "hush" }
  | { readonly kind: "worker"; readonly message: FromWorker }
  // A report from the player of the preview with this id.
  | { readonly kind: "player"; readonly unitId: number; readonly state: PlayerState };

export type PreviewCommand =
  | { readonly kind: "worker"; readonly message: ToWorker }
  | { readonly kind: "player"; readonly unitId: number; readonly event: PlayerEvent };

export interface PreviewPlan {
  readonly state: PreviewState;
  readonly commands: ReadonlyArray<PreviewCommand>;
}

const toWorker = (message: ToWorker): PreviewCommand => ({ kind: "worker", message });
const toPlayer = (unitId: number, event: PlayerEvent): PreviewCommand => ({ kind: "player", unitId, event });

// The request for the sounding preview, withdrawn; nothing when none sounds.
const withdraw = (state: PreviewState): ReadonlyArray<PreviewCommand> =>
  state.sounding === null ? [] : [toWorker({ kind: "cancel", unitId: state.sounding.unitId })];

// The very same state object when nothing was sounding: nothing changed, and it says so.
const silent = (state: PreviewState): PreviewState => (state.sounding === null ? state : { ...state, sounding: null });
const stay = (state: PreviewState): PreviewPlan => ({ state, commands: [] });

// [LAW:dataflow-not-control-flow] The worker's messages for the sounding preview, one row
// per kind: frames and the end go to its player, a failure ends it, and a message the
// protocol says cannot come for it — a cancel it never sent — is a bug and throws. Every
// message for another id is another conversation's. A refusal is judged first, sounding
// or not: every request below zero is this previewer's, and a refused one means the worker
// left `ready` under it, which is a bug [LAW:no-silent-failure].
const fromWorker = (state: PreviewState, message: FromWorker): PreviewPlan => {
  if (message.kind === "refused") {
    if ("unitId" in message.request && message.request.unitId < 0) {
      throw new Error(`voice preview: ${message.request.kind} of preview ${message.request.unitId} refused in phase ${message.phase}`);
    }
    return stay(state);
  }
  const { sounding } = state;
  if (sounding === null) return stay(state);
  switch (message.kind) {
    case "audio":
      return message.unitId !== sounding.unitId
        ? stay(state)
        : { state, commands: [toPlayer(sounding.unitId, { kind: "frame", unit: 0, frameIndex: message.frameIndex, pcm: message.pcm })] };
    case "done":
      return message.unitId !== sounding.unitId ? stay(state) : { state, commands: [toPlayer(sounding.unitId, { kind: "complete", unit: 0 })] };
    case "failed":
      // [LAW:no-silent-failure] The frames so far are void; the preview ends unheard and
      // the panel's readout shows nothing sounding. The reason is the worker's to log.
      return message.unitId !== sounding.unitId ? stay(state) : { state: silent(state), commands: [] };
    case "cancelled":
      if (message.unitId === sounding.unitId) throw new Error(`voice preview: preview ${message.unitId} was cancelled while sounding`);
      return stay(state);
    default:
      return stay(state);
  }
};

export const step = (state: PreviewState, event: PreviewEvent): PreviewPlan => {
  switch (event.kind) {
    case "say": {
      const unitId = state.next;
      return {
        state: { sounding: { voice: event.voice, unitId }, next: unitId - 1 },
        commands: [
          ...withdraw(state),
          toWorker({ kind: "synthesize", unitId, text: previewText(event.voice), voice: event.voice }),
          toPlayer(unitId, { kind: "play" }),
        ],
      };
    }
    case "hush":
      return { state: silent(state), commands: withdraw(state) };
    case "worker":
      return fromWorker(state, event.message);
    case "player":
      // Its player went idle: the phrase was said to its end. A report from a replaced
      // preview's player is over already.
      return event.unitId === state.sounding?.unitId && event.state.kind === "idle" ? { state: silent(state), commands: [] } : stay(state);
  }
};

// ── the driver ─────────────────────────────────────────────────────────────────────────

export interface PreviewerConfig {
  readonly port: SynthesisPort;
  // What opens the preview's own audio device: `AudioContext` in the page. Opened on the
  // first preview, which is the reader's tap — the gesture a browser requires — and closed
  // with the previewer.
  readonly Device: DeviceFactory;
  // Called with the voice sounding whenever that changes, and with null when none does.
  readonly onChange: (sounding: VoiceId | null) => void;
}

export interface Previewer {
  readonly say: (voice: VoiceId) => void;
  readonly hush: () => void;
  readonly state: () => PreviewState;
  // Silences the preview, ends its players, closes the device, stops hearing the port.
  readonly dispose: () => void;
}

export const createPreviewer = (config: PreviewerConfig): Previewer => {
  // [LAW:no-shared-mutable-globals] Owned here; written only by `dispatch`, from `step`.
  let state = initialState();
  const queue: PreviewEvent[] = [];
  let draining = false;
  let disposed = false;
  let audio: OpenDevice | null = null;
  const device = (): OpenDevice => (audio ??= openDevice(config.Device));
  const players = new Map<number, UnitPlayer>();
  const playerOf = (unitId: number): UnitPlayer => {
    const held = players.get(unitId);
    if (held !== undefined) return held;
    const built = createUnitPlayer({ device: device(), unitCount: 1, onState: (reported) => dispatch({ kind: "player", unitId, state: reported }) });
    players.set(unitId, built);
    return built;
  };
  const perform = (command: PreviewCommand): void =>
    command.kind === "worker" ? config.port.send(command.message) : playerOf(command.unitId).send(command.event);
  // A player lives exactly while the state names its preview.
  const reap = (): void => {
    for (const [unitId, player] of players) {
      if (unitId === state.sounding?.unitId) continue;
      players.delete(unitId);
      player.dispose();
    }
  };

  const dispatch = (event: PreviewEvent): void => {
    queue.push(event);
    if (draining) return;
    draining = true;
    try {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const before = state.sounding;
        const planned = step(state, next);
        state = planned.state;
        reap();
        for (const command of planned.commands) perform(command);
        if (!disposed && state.sounding?.voice !== before?.voice) config.onChange(state.sounding?.voice ?? null);
      }
    } finally {
      draining = false;
    }
  };

  const unsubscribe = config.port.subscribe((message) => dispatch({ kind: "worker", message }));

  return {
    say: (voice) => dispatch({ kind: "say", voice }),
    hush: () => dispatch({ kind: "hush" }),
    state: () => state,
    dispose: () => {
      disposed = true;
      dispatch({ kind: "hush" });
      unsubscribe();
      void audio?.device.close();
      audio = null;
    },
  };
};
