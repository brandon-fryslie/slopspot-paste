// [LAW:decomposition] The neural voice as a performer: the scheduler and the unit player
// behind the seam the panel drives. One sentence, no "and": this module answers the
// performer's verbs and reports the performer's position for the neural pipeline. It
// decides nothing about what to synthesize (scheduler.ts), plays nothing itself
// (unitPlayer.ts) and paints nothing; it translates between the conversation's clock — a
// time on the timeline — and the player's — a segment of the timeline's layout, an offset
// into it.
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
// every call, and the timeline is built from the scheduler's manifest over the same layout
// the player plays — one speech segment per unit, in unit order, the gap between speakers
// a silence segment of the timeline's own between them — so the two conversions below are
// one array read in each direction over `timeline.segments`, the player's segment index
// being the timeline's. The gap is the timeline's, not any unit's: a player position
// inside a gap reads as a time inside that silence segment, and a time inside a gap seeks
// to that offset of that segment. Two caps keep the clock honest: the player's offset reads
// no further than the segment, since while a unit streams its segment is still the
// estimate the clock is laid on; and a seek lands no further into a speech segment than
// has been heard — its length when measured, its start when a guess — the rule `timeAt`
// applies to a place, stated once there and once here [LAW:single-enforcer]. Silence is
// never a guess, so a seek lands anywhere in it. The timeline is delivered with every view,
// cut once per manifest, so a reader of the view — the panel's cursor, its scrubber, its
// status line — never builds a second one and the per-frame read is one array index.
//
// [LAW:no-ambient-temporal-coupling] A disposed performer says nothing more: the view the
// released scheduler raises from its own dispose never reaches the caller.

import type { Performer, PerformerEvent } from "./performer";
import { createScheduler, type SchedulerView } from "./scheduler";
import type { Utterance } from "./speech";
import type { SynthesisUnit, VoiceMap } from "./speechScript";
import type { SynthesisPort } from "./synthesisClient";
import { speechSegments, timelineOfScript, type Segment, type SpeechSegment, type Timeline } from "./timeline";
import { createUnitPlayer, type OpenDevice, type SegmentOffset } from "./unitPlayer";

// The scheduler's view with the conversation's clock attached, built over its manifest,
// and the clock's speech segments by unit, for whoever names a unit by its passage.
export interface NeuralView extends SchedulerView {
  readonly timeline: Timeline;
  readonly units: ReadonlyArray<SpeechSegment>;
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

// The segment a player position is in. A segment the timeline does not have is a player
// built over another layout and throws [LAW:no-silent-failure].
const segmentOf = (timeline: Timeline, at: SegmentOffset): Segment => {
  const segment = timeline.segments[at.segment];
  if (segment === undefined) throw new RangeError(`neural performer: the player is at segment ${at.segment} of ${timeline.segments.length}`);
  return segment;
};

// Where an offset into a segment falls on the conversation's clock: the segment's start
// plus the offset, read no further than the segment — a unit streaming past its guessed
// length holds the clock at the segment's end until its record recuts the timeline.
const timeIn = (segment: Segment, offsetMs: number): number => segment.startMs + Math.min(offsetMs, segment.ms);

// Where the player's position falls on the conversation's clock.
export const timeOf = (timeline: Timeline, at: SegmentOffset): number => timeIn(segmentOf(timeline, at), at.offsetMs);

// How far into a segment a seek may land: anywhere in silence, which is exact; in speech
// as far as has been heard — its length when measured, nothing when a guess.
const heard = (segment: Segment): number => (segment.content.kind === "speech" && segment.content.alignment === null ? 0 : segment.ms);

// The player position a time seeks to: the segment the time is in — the first that has
// not ended by then, speech or silence alike — and the time past its start, never below
// zero and no further than has been heard. Before the top is the first segment's start;
// past the end is the last segment's end; a timeline with no segments has nothing to seek
// and throws.
export const segmentOffsetAt = (timeline: Timeline, ms: number): SegmentOffset => {
  const found = timeline.segments.findIndex((segment) => segment.startMs + segment.ms > ms);
  const index = found < 0 ? timeline.segments.length - 1 : found;
  const segment = timeline.segments[index];
  if (segment === undefined) throw new RangeError("neural performer: nothing to seek in a timeline with no segments");
  return { segment: index, offsetMs: Math.min(Math.max(ms - segment.startMs, 0), heard(segment)) };
};

// [LAW:types-are-the-program] The performer's state with the segment the voice is in,
// which the player's index names outright. A time alone is a lossy projection of it: read
// back through the timeline it names a neighbour while a unit streams past its guessed
// length, and costs a scan over every segment for what an index already said.
export type NeuralState = { readonly kind: "idle" } | { readonly kind: "speaking" | "paused"; readonly atMs: number; readonly segment: Segment };

// Where the neural voice is, on the conversation's clock and in which segment: nothing
// while idle.
export const stateOf = (view: NeuralView): NeuralState => {
  const { player } = view;
  if (player.kind === "idle") return { kind: "idle" };
  const segment = segmentOf(view.timeline, player.at);
  return { kind: player.kind, atMs: timeIn(segment, player.at.offsetMs), segment };
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
  let clock: { readonly manifest: SchedulerView["manifest"]; readonly timeline: Timeline; readonly units: ReadonlyArray<SpeechSegment> } | null = null;
  const withClock = (view: SchedulerView): NeuralView => {
    if (clock === null || clock.manifest !== view.manifest) {
      const timeline = timelineOfScript(view.manifest, utteranceOf);
      clock = { manifest: view.manifest, timeline, units: speechSegments(timeline) };
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
    scheduler.send(event.kind === "seek" ? { kind: "seek", to: segmentOffsetAt(view().timeline, event.toMs) } : event);

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
