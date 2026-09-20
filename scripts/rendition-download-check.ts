// The rendition download (slopspot-read-along-a35.8): one tap carried to a saved file, driven
// over a stub render and a stub save, with the real stitch and the real WAV encoder.
// Run: `tsx scripts/rendition-download-check.ts`.
//
// [LAW:behavior-not-structure] Every assertion is about the phases the reader is shown, what
// the port is asked to render, and what is saved.

import { encodeFile, type AudioFile, type FileForm } from "../src/renditionFile";
import { startDownload, type DownloadPhase } from "../src/renditionDownload";
import { unitRequest } from "../src/scheduler";
import { prepareText, type SynthesisUnit, type VoiceMap } from "../src/speechScript";
import type { RenderedUnit, SynthesizeRequest } from "../src/synthesisClient";
import { GAP_MS } from "../src/timeline";
import { MODEL_PCM } from "../src/unitPlayer";

const assert = (label: string, cond: boolean): void => {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await flush();
};

const VOICES: VoiceMap = { user: "charles", assistant: "paul", system: "javert", narrator: "jane" };
// Two turns: the user's one unit, the assistant's two.
const unitOf = (anchor: string, voice: "user" | "assistant", text: string): SynthesisUnit => ({
  utterance: { index: anchor === "t0" ? 0 : 1, anchor, origin: "page", voice, text },
  start: 0,
  end: text.length,
  ...prepareText(text),
});
const script: ReadonlyArray<SynthesisUnit> = [unitOf("t0", "user", "Hi."), unitOf("t1", "assistant", "Hello."), unitOf("t1", "assistant", "Welcome.")];
const made = (unitId: number, frames: number): RenderedUnit => ({ kind: "made", unitId, frames: Array.from({ length: frames }, () => new Float32Array(MODEL_PCM.frameSamples).fill(0.25)) });

// The port's render, held for the case to answer; and the page's save.
const rig = (overrides: { encode?: typeof encodeFile; form?: () => Promise<FileForm> } = {}) => {
  const renders: { requests: ReadonlyArray<SynthesizeRequest>; onUnit: (unit: RenderedUnit) => void; withdrawn: boolean }[] = [];
  const phases: DownloadPhase[] = [];
  const saved: { file: AudioFile; name: string }[] = [];
  // [LAW:no-ambient-temporal-coupling] The download's last word, awaited as an event: how many
  // turns a real encoder takes is the runtime's (Node 22 first imports mediabunny in hundreds).
  let ended: () => void = () => undefined;
  const over = new Promise<void>((resolve) => (ended = resolve));
  const withdraw = startDownload({
    port: {
      render: (requests, onUnit) => {
        const render = { requests, onUnit, withdrawn: false };
        renders.push(render);
        return () => {
          render.withdrawn = true;
        };
      },
    },
    script,
    voices: VOICES,
    format: MODEL_PCM,
    name: "a-paste",
    form: overrides.form ?? (async () => ({ container: "wav" })),
    encode: overrides.encode ?? encodeFile,
    save: (file, name) => saved.push({ file, name }),
    onPhase: (phase) => {
      phases.push(phase);
      if (phase.kind === "saved" || phase.kind === "failed") ended();
    },
  });
  const shown = (): string =>
    phases
      .map((p) => (p.kind === "rendering" ? `rendering ${p.made}/${p.total}` : p.kind === "encoding" ? `encoding ${p.fraction === 0 ? 0 : p.fraction === 1 ? 1 : "part"}` : p.kind === "saved" ? `saved ${p.name} missing[${p.missing.join()}]` : `failed ${p.message}`))
      .filter((p, i, all) => i === 0 || p !== all[i - 1])
      .join(" > ");
  const heard = (unit: RenderedUnit): void => renders[0]?.onUnit(unit);
  return { renders, phases, saved, withdraw, shown, heard, over };
};

console.log("a download from tap to file");
{
  const r = rig();
  assert("one render of every unit, each asked as the listen asks for it, in the reader's voices", r.renders.length === 1 && JSON.stringify(r.renders[0]?.requests) === JSON.stringify(script.map((_, unitId) => unitRequest(script, VOICES, unitId))));
  assert("rendering from the start, nothing made yet", r.shown() === "rendering 0/3");
  r.heard(made(2, 1));
  r.heard(made(0, 2));
  assert("each unit counted as it is heard, in whatever order", r.shown() === "rendering 0/3 > rendering 1/3 > rendering 2/3" && r.saved.length === 0);
  r.heard(made(1, 3));
  await r.over;
  assert("the last heard: encoded, saved under its form's name, and nothing missing", r.shown() === "rendering 0/3 > rendering 1/3 > rendering 2/3 > rendering 3/3 > encoding 0 > encoding part > encoding 1 > saved a-paste.wav missing[]");
  const samples = (2 + 3 + 1) * MODEL_PCM.frameSamples + (GAP_MS * MODEL_PCM.sampleRate) / 1000;
  assert("one file saved: the timeline's samples, the gap between the turns included", r.saved.length === 1 && r.saved[0]?.name === "a-paste.wav" && r.saved[0].file.bytes.byteLength === 44 + 2 * samples);
}
{
  const r = rig();
  r.heard(made(0, 1));
  r.heard({ kind: "failed", unitId: 1, reason: { kind: "frame-cap", frames: 500 } });
  r.heard(made(2, 1));
  await r.over;
  assert("a unit the voice failed on: the file saved without it, and it is named", r.shown().endsWith("saved a-paste.wav missing[1]") && r.saved.length === 1);
}
{
  const r = rig({ encode: async () => Promise.reject(new Error("the encoder closed")) });
  [0, 1, 2].forEach((unitId) => r.heard(made(unitId, 1)));
  await r.over;
  assert("an encoder that fails: failed, with its reason, nothing saved", r.shown().endsWith("encoding 0 > failed the encoder closed") && r.saved.length === 0);
}
{
  const r = rig();
  r.heard(made(0, 1));
  r.withdraw();
  r.heard(made(1, 1));
  r.heard(made(2, 1));
  await settle();
  assert("withdrawn while rendering: the render withdrawn, and nothing more said or saved", r.renders[0]?.withdrawn === true && r.shown() === "rendering 0/3 > rendering 1/3" && r.saved.length === 0);
}
{
  let release: (form: FileForm) => void = () => undefined;
  let encodes = 0;
  const r = rig({
    form: () => new Promise((resolve) => (release = resolve)),
    encode: (...args) => {
      encodes += 1;
      return encodeFile(...args);
    },
  });
  [0, 1, 2].forEach((unitId) => r.heard(made(unitId, 1)));
  await settle();
  r.withdraw();
  release({ container: "wav" });
  await settle();
  assert("withdrawn while the form is asked: nothing encoded, nothing saved, and nothing said after", r.shown().endsWith("encoding 0") && encodes === 0 && r.saved.length === 0);
}
{
  const withdrawing = { now: (): void => undefined };
  let runs = 0;
  let encoded: Promise<string> = Promise.resolve("never encoded");
  const r = rig({
    encode: (audio, format, form, onProgress, signal) => {
      const encoding = encodeFile(audio, format, form, (fraction) => {
        runs += 1;
        onProgress(fraction);
        withdrawing.now();
      }, signal);
      encoded = encoding.then(
        () => "finished",
        () => "stopped",
      );
      return encoding;
    },
  });
  withdrawing.now = r.withdraw;
  [0, 1, 2].forEach((unitId) => r.heard(made(unitId, 1)));
  await settle();
  const outcome = await encoded;
  await settle();
  assert("withdrawn while encoding: the encode stopped at its next run, nothing saved, and nothing said after", outcome === "stopped" && runs === 1 && r.shown().endsWith("encoding 0 > encoding part") && r.saved.length === 0);
}

console.log(process.exitCode === 1 ? "rendition-download-check: FAILED" : "rendition-download-check: ok");
