// [LAW:decomposition] The neural voice as a performer: the scheduler and the unit player
// behind the seam the panel drives. One sentence, no "and": this module answers the
// performer's verbs and reports the performer's position for the neural pipeline. It
// decides nothing about what to synthesize (scheduler.ts), plays nothing itself
// (unitPlayer.ts) and paints nothing; it translates between the page's coordinates — an
// utterance index, a span of the utterance's text — and the pipeline's — a unit index, an
// offset into the unit's audio.
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
// every call; the cursor is the manifest's when the unit has a record and the unit's own
// span with no word while it is still being synthesized. A seek to a mark is the same
// table read the other way — `positionOf`: the unit of that utterance holding the
// character, and the time its word begins when the unit has a record, its start when it
// does not. The table is delivered with every view, so a reader of the view (the panel's
// status line, naming a failed unit's passage) needs no second copy.
//
// [LAW:no-ambient-temporal-coupling] A disposed performer says nothing more: the view the
// released scheduler raises from its own dispose never reaches the caller.

import type { Mark, Performer, PerformerEvent, PerformerState, Spot } from "./performer";
import { createScheduler, type SchedulerView } from "./scheduler";
import type { Utterance } from "./speech";
import { cursorAt, offsetAt, unitSpan, type Manifest, type Position } from "./speechManifest";
import type { SynthesisUnit, VoiceMap } from "./speechScript";
import type { SynthesisPort } from "./synthesisClient";
import { createUnitPlayer, type DeviceFactory } from "./unitPlayer";

// The scheduler's view with the table attached: for each unit of the script, the index
// of the page utterance it says.
export interface NeuralView extends SchedulerView {
  readonly utteranceOf: ReadonlyArray<number>;
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

// Where the neural voice is, in the page's coordinates: nothing while idle; otherwise the
// utterance under the player and the cursor to paint — the manifest's when the unit has a
// record, the unit's whole span and no word while it is still being synthesized.
export const spotOf = (view: NeuralView): PerformerState => {
  const { player } = view;
  if (player.kind === "idle") return { kind: "idle" };
  const { unitIndex, offsetMs } = player.at;
  const unit = view.manifest.script[unitIndex];
  const utterance = view.utteranceOf[unitIndex];
  if (unit === undefined || utterance === undefined) {
    throw new Error(`neural performer: the player is at unit ${unitIndex} of ${view.manifest.script.length}`);
  }
  const record = view.manifest.units[unitIndex];
  const at: Spot = { utterance, ...(record === undefined ? { segment: unitSpan(unit), word: null } : cursorAt(record, offsetMs)) };
  return { kind: player.kind, at };
};

// The pipeline position a mark seeks to: among the units that say the mark's utterance
// (contiguous, and never empty — every utterance has one), the last whose text begins at
// or before the character, else the first; and within it, the time the word holding the
// character begins when the unit is recorded, its start when it is not. A mark naming an
// utterance the page does not have is a caller bug and throws [LAW:no-silent-failure].
export const positionOf = (manifest: Manifest, utteranceOf: ReadonlyArray<number>, mark: Mark): Position => {
  const saying = manifest.script.flatMap((unit, unitIndex) => (utteranceOf[unitIndex] === mark.utterance ? [{ unit, unitIndex }] : []));
  const first = saying[0];
  if (first === undefined) throw new RangeError(`neural performer: cannot seek to utterance ${mark.utterance}`);
  const { unitIndex } = saying.findLast(({ unit }) => unit.start <= mark.char) ?? first;
  const record = manifest.units[unitIndex];
  return { unitIndex, offsetMs: record === undefined ? 0 : offsetAt(record, mark.char) };
};

export interface NeuralPerformerConfig {
  readonly port: SynthesisPort;
  readonly script: ReadonlyArray<SynthesisUnit>;
  readonly utterances: ReadonlyArray<Utterance>;
  readonly voices: VoiceMap;
  readonly Device: DeviceFactory;
  // Called after every event that changed what is held or where the player is.
  readonly onChange: (view: NeuralView) => void;
}

export interface NeuralPerformer extends Performer {
  readonly view: () => NeuralView;
}

export const createNeuralPerformer = (config: NeuralPerformerConfig): NeuralPerformer => {
  const utteranceOf = utteranceTable(config.utterances, config.script);
  const withTable = (view: SchedulerView): NeuralView => ({ ...view, utteranceOf });
  // [LAW:no-shared-mutable-globals] The performer's one lifecycle fact, owned here.
  let disposed = false;

  const scheduler = createScheduler({
    port: config.port,
    script: config.script,
    voices: config.voices,
    player: (playerConfig) => createUnitPlayer({ ...playerConfig, Device: config.Device }),
    onChange: (view) => {
      if (!disposed) config.onChange(withTable(view));
    },
  });

  const view = (): NeuralView => withTable(scheduler.view());

  const send = (event: PerformerEvent): void =>
    scheduler.send(event.kind === "seek" ? { kind: "seek", to: positionOf(scheduler.view().manifest, utteranceOf, event.to) } : event);

  return {
    send,
    state: () => spotOf(view()),
    view,
    dispose: () => {
      disposed = true;
      scheduler.dispose();
    },
  };
};
