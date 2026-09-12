// The neural voice behind the performer seam: the utterance table at the door, seeks in
// the page's coordinates, the position read back in them (slopspot-read-along-a35.1).
// Run: `tsx scripts/neural-performer-check.ts`.
//
// [LAW:behavior-not-structure] What is asserted is the contract the panel drives: which
// unit a seek to an utterance starts, which utterance and span the performer reports, and
// that a script that is not this page's is refused. The real scheduler and the real unit
// player run underneath, over the stub device and a stub port.

import { createNeuralPerformer, passages, spotOf, utteranceTable, type NeuralView } from "../src/neuralPerformer";
import type { PerformerState } from "../src/performer";
import type { Utterance } from "../src/speech";
import { emptyManifest, type UnitReport } from "../src/speechManifest";
import { DEFAULT_VOICES, type SynthesisUnit } from "../src/speechScript";
import type { SynthesisPort } from "../src/synthesisClient";
import type { FromWorker, ToWorker } from "../src/synthesisProtocol";
import { SCHEDULE_LEAD_S } from "../src/unitPlayer";
import { FRAME_S, frame, StubDevice } from "./playbackStub";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const throws = (label: string, f: () => unknown): void => {
  let threw = false;
  try {
    f();
  } catch {
    threw = true;
  }
  assert(label, threw);
};

// ── fixtures ──────────────────────────────────────────────────────────────────────────

// Three utterances on two turns; the first is long enough for two units. The script's
// units hold CLONES of the utterances, as the worker's structured clone hands them back:
// the same values, never the same objects.
const one: Utterance = { index: 1, anchor: "t1", voice: "user", text: "First sentence here. Second sentence here." };
const two: Utterance = { index: 1, anchor: "t1", voice: "narrator", text: "python code block, 2 lines." };
const three: Utterance = { index: 2, anchor: "t2", voice: "assistant", text: "A reply." };
const utterances = [one, two, three];
const clone = (u: Utterance): Utterance => ({ ...u });
const unit = (utterance: Utterance, start: number, end: number): SynthesisUnit => ({ utterance, start, end, text: utterance.text.slice(start, end) });
const script = ((): SynthesisUnit[] => {
  const [a, b, c] = [clone(one), clone(two), clone(three)];
  return [unit(a, 0, 20), unit(a, 21, 42), unit(b, 0, 27), unit(c, 0, 8)];
})();

const describe = (state: PerformerState): string =>
  state.kind === "idle" ? "idle" : `${state.kind}@${state.at.utterance} ${state.at.span.charStart}-${state.at.span.charEnd}`;

console.log("utteranceTable: the script's passages are the page's utterances, one for one");
{
  assert("passages are utterances, not units", passages(script).length === 3);
  assert("each unit names the utterance it says", utteranceTable(utterances, script).join() === "0,0,1,2");
  throws("a script with a passage the page lacks is refused", () => utteranceTable([one, three], script));
  throws("a script whose passage differs from the page's utterance is refused", () => utteranceTable([one, { ...two, text: "other" }, three], script));
  throws("a script shorter than the page is refused", () => utteranceTable(utterances, script.slice(0, 2)));
}

console.log("spotOf: the position in the page's coordinates");
{
  const table = utteranceTable(utterances, script);
  const view = (player: NeuralView["player"]): NeuralView => ({ player, manifest: emptyManifest(script), holdings: script.map(() => ({ kind: "absent" })), utteranceOf: table });
  assert("idle is idle", describe(spotOf(view({ kind: "idle" }))) === "idle");
  assert("a unit with no record yet reports its whole span", describe(spotOf(view({ kind: "speaking", at: { unitIndex: 1, offsetMs: 0 }, flow: "waiting" }))) === "speaking@0 21-42");
  assert("the second passage's unit reports the second utterance", describe(spotOf(view({ kind: "paused", at: { unitIndex: 2, offsetMs: 0 } }))) === "paused@1 0-27");
  throws("a position past the script is a bug, not a span", () => spotOf(view({ kind: "paused", at: { unitIndex: 9, offsetMs: 0 } })));
}

console.log("createNeuralPerformer: over the real scheduler and player");
{
  const sent: ToWorker[] = [];
  const listeners = new Set<(message: FromWorker) => void>();
  const port: SynthesisPort = {
    send: (message) => sent.push(message),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    errors: () => () => undefined,
    dispose: () => undefined,
    terminate: () => undefined,
  };
  const emit = (message: FromWorker): void => {
    for (const listener of listeners) listener(message);
  };
  const said = (): string => sent.map((m) => (m.kind === "synthesize" ? `synthesize ${m.unitId}` : m.kind === "cancel" ? `cancel ${m.unitId}` : m.kind)).join();
  const report = (durationMs: number): UnitReport => ({ durationMs, alignment: { kind: "unit" } });

  const views: NeuralView[] = [];
  const performer = createNeuralPerformer({ port, script, utterances, voices: DEFAULT_VOICES, Device: StubDevice, onChange: (view) => views.push(view) });
  const device = StubDevice.instances.at(-1);
  if (device === undefined) throw new Error("the performer did not build a player");

  assert("built idle, nothing requested yet", describe(performer.state()) === "idle" && sent.length === 0);
  assert("the view carries the table", performer.view().utteranceOf.join() === "0,0,1,2");

  performer.send({ kind: "seek", to: 1 });
  assert("a seek to the second utterance starts its first unit, waiting on synthesis", describe(performer.state()) === "speaking@1 0-27" && said() === "synthesize 2");
  assert("the change is reported with the table attached", views.at(-1)?.utteranceOf.join() === "0,0,1,2" && views.at(-1)?.player.kind === "speaking");

  performer.send({ kind: "pause" });
  assert("pausing holds the place", describe(performer.state()) === "paused@1 0-27");
  performer.send({ kind: "seek", to: 2 });
  assert("seeking while paused stays paused, at the new utterance", describe(performer.state()) === "paused@2 0-8");
  throws("a seek to an utterance the page does not have throws", () => performer.send({ kind: "seek", to: 3 }));

  performer.send({ kind: "play" });
  emit({ kind: "audio", unitId: 3, frameIndex: 0, pcm: frame(3, 0) });
  emit({ kind: "done", unitId: 3, report: report(FRAME_S * 1000), elapsedMs: 5 });
  assert("audio for the unit: playing the last utterance", describe(performer.state()) === "speaking@2 0-8");
  device.advance(SCHEDULE_LEAD_S + FRAME_S + 0.01);
  assert("the last unit ends: idle", describe(performer.state()) === "idle");

  performer.send({ kind: "play" });
  assert("play from idle starts at the top", describe(performer.state()) === "speaking@0 0-20");

  const before = views.length;
  performer.dispose();
  assert("dispose stops the player and closes the device", performer.view().player.kind === "idle" && device.calls.at(-1) === "close");
  assert("a disposed performer reports nothing more", views.length === before);
}

console.log(process.exitCode === 1 ? "neural-performer-check: FAILED" : "neural-performer-check: ok");
