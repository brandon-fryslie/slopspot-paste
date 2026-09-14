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
// unit, in unit order, with the gap between speakers laid as a silence leg between them —
// so the two conversions below are one array read in each direction: a unit's offset is
// its speech leg's start plus the offset, and a time is the last speech leg starting at or
// before it plus the difference. A time inside a gap is the previous unit's clock past its
// last sample, which is exactly how the player plays the gap, so neither direction has a
// case for silence [LAW:dataflow-not-control-flow]. The same rule that lays the gaps on
// the clock (`leadsOf`) hands the player the lead-in before each unit, so the clock and the
// audio cannot disagree [LAW:single-enforcer]. The timeline is delivered with every view,
// built once per view, so a reader of the view — the panel's cursor, its scrubber, its
// status line — never builds a second one.
//
// [LAW:no-ambient-temporal-coupling] A disposed performer says nothing more: the view the
// released scheduler raises from its own dispose never reaches the caller.

import type { Performer, PerformerEvent, PerformerState } from "./performer";
import { createScheduler, type SchedulerView } from "./scheduler";
import type { Utterance } from "./speech";
import type { Position } from "./speechManifest";
import type { SynthesisUnit, VoiceMap } from "./speechScript";
import type { SynthesisPort } from "./synthesisClient";
import { leadsOf, speechLegs, timelineOfScript, type Timeline } from "./timeline";
import { createUnitPlayer, type OpenDevice } from "./unitPlayer";

// The scheduler's view with the conversation's clock attached, built over its manifest.
export interface NeuralView extends SchedulerView {
  readonly timeline: Timeline;
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

// The start of each unit's speech leg on the clock: the one table both conversions read.
const unitStarts = (timeline: Timeline): ReadonlyArray<number> => speechLegs(timeline).map((leg) => leg.startMs);

// Where the pipeline's position falls on the conversation's clock. A unit the timeline has
// no leg for is a player built over another script and throws [LAW:no-silent-failure].
export const timeOf = (timeline: Timeline, at: Position): number => {
  const start = unitStarts(timeline)[at.unitIndex];
  if (start === undefined) throw new RangeError(`neural performer: the player is at unit ${at.unitIndex} of ${unitStarts(timeline).length}`);
  return start + at.offsetMs;
};

// The pipeline position a time seeks to: the last unit whose speech leg begins at or
// before the time, and the time past that leg's start — into the unit's audio, or past its
// end into the gap that follows, which the player spends as lead. Before the first leg is
// the first unit's start; a timeline with no legs has no unit to seek and throws.
export const positionAt = (timeline: Timeline, ms: number): Position => {
  const starts = unitStarts(timeline);
  const unitIndex = Math.max(0, starts.findLastIndex((start) => start <= ms));
  const start = starts[unitIndex];
  if (start === undefined) throw new RangeError("neural performer: nothing to seek in a script with no units");
  return { unitIndex, offsetMs: Math.max(0, ms - start) };
};

// Where the neural voice is, on the conversation's clock: nothing while idle.
export const stateOf = (view: NeuralView): PerformerState => {
  const { player } = view;
  if (player.kind === "idle") return { kind: "idle" };
  return { kind: player.kind, atMs: timeOf(view.timeline, player.at) };
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
  readonly view: () => NeuralView;
  // The reader's voices from now on; the scheduler remakes the units of a changed voice.
  readonly voices: (voices: VoiceMap) => void;
}

export const createNeuralPerformer = (config: NeuralPerformerConfig): NeuralPerformer => {
  const utteranceOf = utteranceTable(config.utterances, config.script);
  // [LAW:one-source-of-truth] The clock is a projection of the manifest, rebuilt exactly
  // when the manifest is replaced — the scheduler replaces it on every record — and read
  // back otherwise: one owner, one key.
  let clock: { readonly manifest: SchedulerView["manifest"]; readonly timeline: Timeline } | null = null;
  const withClock = (view: SchedulerView): NeuralView => {
    if (clock === null || clock.manifest !== view.manifest) clock = { manifest: view.manifest, timeline: timelineOfScript(view.manifest, utteranceOf) };
    return { ...view, timeline: clock.timeline };
  };
  // [LAW:no-shared-mutable-globals] The performer's one lifecycle fact, owned here.
  let disposed = false;

  const scheduler = createScheduler({
    port: config.port,
    script: config.script,
    voices: config.voices,
    player: (playerConfig) =>
      createUnitPlayer({ ...playerConfig, device: config.device, leads: leadsOf(config.script.map((unit) => unit.utterance.anchor)) }),
    onChange: (view) => {
      if (!disposed) config.onChange(withClock(view));
    },
  });

  const view = (): NeuralView => withClock(scheduler.view());

  const send = (event: PerformerEvent): void =>
    scheduler.send(event.kind === "seek" ? { kind: "seek", to: positionAt(view().timeline, event.toMs) } : event);

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
