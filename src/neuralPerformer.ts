// [LAW:decomposition] The neural voice as a performer: the scheduler and the unit player
// behind the seam the panel drives. One sentence, no "and": this module answers the
// performer's verbs and reports the performer's position for the neural pipeline. It
// decides nothing about what to synthesize (scheduler.ts), plays nothing itself
// (unitPlayer.ts) and paints nothing; it translates between the conversation's clock — a
// time on the timeline — and the pipeline's — a unit index, an offset into the unit's
// audio.
//
// [LAW:parse-dont-validate] The translation rests on one table, `utteranceOf`, built once
// at the door from the page's utterances and the worker's script: for each unit, the index
// of the utterance it says. The script is the page's utterances cut into units in order,
// and every utterance is non-blank (speech.ts admits no blank one), so every utterance has
// at least one unit and the script's passages are the page's utterances, position for
// position. That is checked here, value for value — the worker's structured clone breaks
// object identity, never text — and a script that is not this page's is refused loudly
// rather than seeked through by a table that lies [LAW:no-silent-failure].
//
// [LAW:one-source-of-truth] The position is the unit player's, read from the audio clock on
// every call, and the timeline is built from the scheduler's manifest — one speech leg per
// unit, in unit order, with the gap between speakers laid as a silence leg of the
// timeline's own between them — so the two conversions below are one array read in each
// direction over `units`, the speech legs by unit. The gap is the timeline's, not any
// unit's: a player position is always inside a unit's audio and reads as a time inside
// that unit's leg; a time inside a gap seeks to the first sample of the unit that follows
// the gap, the same rule `markAt` names a place in silence by. Two caps keep the clock
// honest: the player's offset reads no further than the unit's leg, since while a unit
// streams its leg is still the estimate the clock is laid on; and a seek lands no further
// into a leg than has been heard — its length when measured, its start when a guess — the
// rule `timeAt` applies to a mark, stated once there and once here [LAW:single-enforcer].
// The timeline and its unit legs are delivered with every view, cut once per manifest, so
// a reader of the view — the panel's cursor, its scrubber, its status line — never builds a
// second one and the per-frame read is one array index.
//
// The player does not yet sound the gap: it plays units back to back, so at a change of
// speaker the clock steps over the silence leg the moment the next unit's audio begins.
// Sounding the gap is the player's work to come, as a stretch of the schedule in its own
// right — never as a lead owned by the unit after it.
//
// [LAW:no-ambient-temporal-coupling] A disposed performer says nothing more: the view the
// released scheduler raises from its own dispose never reaches the caller.

import type { Performer, PerformerEvent } from "./performer";
import { createScheduler, type SchedulerView } from "./scheduler";
import type { Utterance } from "./speech";
import type { Position } from "./speechManifest";
import type { SynthesisUnit, VoiceMap } from "./speechScript";
import type { SynthesisPort } from "./synthesisClient";
import { speechLegs, timelineOfScript, type SpeechLeg, type Timeline } from "./timeline";
import { createUnitPlayer, type OpenDevice } from "./unitPlayer";

// The scheduler's view with the conversation's clock attached, built over its manifest,
// and the clock's speech legs by unit: the one table both conversions read.
export interface NeuralView extends SchedulerView {
  readonly timeline: Timeline;
  readonly units: ReadonlyArray<SpeechLeg>;
}

// Passages are utterances: the script holds each utterance by reference across its
// units, so a passage boundary is where the reference changes.
export const passages = (script: ReadonlyArray<SynthesisUnit>): ReadonlyArray<Utterance> =>
  script.flatMap((unit, i) => (unit.utterance === script[i - 1]?.utterance ? [] : [unit.utterance]));

const sameUtterance = (a: Utterance, b: Utterance): boolean =>
  a.index === b.index && a.anchor === b.anchor && a.voice === b.voice && a.text === b.text;

// For each unit of the script, the index of the page utterance it says. Throws when the
// script's passages are not the page's utterances, one for one.
export const utteranceTable = (utterances: ReadonlyArray<Utterance>, script: ReadonlyArray<SynthesisUnit>): ReadonlyArray<number> => {
  const said = passages(script);
  if (said.length !== utterances.length) {
    throw new Error(`neural performer: the script says ${said.length} passages, the page has ${utterances.length} utterances`);
  }
  utterances.forEach((expected, i) => {
    const passage = said[i];
    if (passage === undefined || !sameUtterance(passage, expected)) {
      throw new Error(`neural performer: passage ${i} of the script is not utterance ${i} of the page (${expected.anchor})`);
    }
  });
  let index = -1;
  return script.map((unit, k) => {
    if (unit.utterance !== script[k - 1]?.utterance) index += 1;
    return index;
  });
};

// The leg a pipeline position is in. A unit the timeline has no leg for is a player built
// over another script and throws [LAW:no-silent-failure].
const legOf = (units: ReadonlyArray<SpeechLeg>, at: Position): SpeechLeg => {
  const leg = units[at.unitIndex];
  if (leg === undefined) throw new RangeError(`neural performer: the player is at unit ${at.unitIndex} of ${units.length}`);
  return leg;
};

// Where an offset into a leg falls on the conversation's clock: the leg's start plus the
// offset, read no further than the leg — a unit streaming past its guessed length holds
// the clock at the leg's end until its record recuts the timeline.
const timeIn = (leg: SpeechLeg, offsetMs: number): number => leg.startMs + Math.min(offsetMs, leg.ms);

// Where the pipeline's position falls on the conversation's clock.
export const timeOf = (units: ReadonlyArray<SpeechLeg>, at: Position): number => timeIn(legOf(units, at), at.offsetMs);

// The pipeline position a time seeks to: the first unit whose leg has not ended by then —
// inside a unit, that unit; inside a gap, the unit the gap precedes, at its first sample —
// and the time past that leg's start, never below zero and no further into the leg than
// has been heard. Before the top is the first unit's start; past the end is the last
// unit's end; a timeline with no legs has no unit to seek and throws.
export const positionAt = (units: ReadonlyArray<SpeechLeg>, ms: number): Position => {
  const found = units.findIndex((leg) => leg.startMs + leg.ms > ms);
  const unitIndex = found < 0 ? units.length - 1 : found;
  const leg = units[unitIndex];
  if (leg === undefined) throw new RangeError("neural performer: nothing to seek in a script with no units");
  const heard = leg.content.alignment === null ? 0 : leg.ms;
  return { unitIndex, offsetMs: Math.min(Math.max(ms - leg.startMs, 0), heard) };
};

// [LAW:types-are-the-program] The performer's state with the leg the voice is in, which
// the player's unit index names outright. A time alone is a lossy projection of it: read
// back through the timeline it names a neighbour while a unit streams past its guessed
// length, and costs a scan over every leg for what an index already said.
export type NeuralState = { readonly kind: "idle" } | { readonly kind: "speaking" | "paused"; readonly atMs: number; readonly leg: SpeechLeg };

// Where the neural voice is, on the conversation's clock and in which leg: nothing while
// idle.
export const stateOf = (view: NeuralView): NeuralState => {
  const { player } = view;
  if (player.kind === "idle") return { kind: "idle" };
  const leg = legOf(view.units, player.at);
  return { kind: player.kind, atMs: timeIn(leg, player.at.offsetMs), leg };
};

export interface NeuralPerformerConfig {
  readonly port: SynthesisPort;
  readonly script: ReadonlyArray<SynthesisUnit>;
  readonly utterances: ReadonlyArray<Utterance>;
  readonly voices: VoiceMap;
  // The audio device, opened on the reader's gesture by the owner that also closes it.
  readonly device: OpenDevice;
  // Called after every event that changed what is held or where the player is.
  readonly onChange: (view: NeuralView) => void;
}

export interface NeuralPerformer extends Performer {
  readonly state: () => NeuralState;
  readonly view: () => NeuralView;
  // The reader's voices from now on; the scheduler remakes the units of a changed voice.
  readonly voices: (voices: VoiceMap) => void;
}

export const createNeuralPerformer = (config: NeuralPerformerConfig): NeuralPerformer => {
  const utteranceOf = utteranceTable(config.utterances, config.script);
  // [LAW:one-source-of-truth] The clock is a projection of the manifest, rebuilt exactly
  // when the manifest is replaced — the scheduler replaces it on every record — and read
  // back otherwise: one owner, one key.
  let clock: { readonly manifest: SchedulerView["manifest"]; readonly timeline: Timeline; readonly units: ReadonlyArray<SpeechLeg> } | null = null;
  const withClock = (view: SchedulerView): NeuralView => {
    if (clock === null || clock.manifest !== view.manifest) {
      const timeline = timelineOfScript(view.manifest, utteranceOf);
      clock = { manifest: view.manifest, timeline, units: speechLegs(timeline) };
    }
    return { ...view, timeline: clock.timeline, units: clock.units };
  };
  // [LAW:no-shared-mutable-globals] The performer's one lifecycle fact, owned here.
  let disposed = false;

  const scheduler = createScheduler({
    port: config.port,
    script: config.script,
    voices: config.voices,
    player: (playerConfig) => createUnitPlayer({ ...playerConfig, device: config.device }),
    onChange: (view) => {
      if (!disposed) config.onChange(withClock(view));
    },
  });

  const view = (): NeuralView => withClock(scheduler.view());

  const send = (event: PerformerEvent): void =>
    scheduler.send(event.kind === "seek" ? { kind: "seek", to: positionAt(view().units, event.toMs) } : event);

  return {
    send,
    voices: scheduler.voices,
    state: () => stateOf(view()),
    view,
    dispose: () => {
      disposed = true;
      scheduler.dispose();
    },
  };
};
