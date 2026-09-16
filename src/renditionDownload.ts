// [LAW:decomposition] The rendition download: one reader's tap carried to a saved file. One
// sentence, no "and" hiding a second job: this module runs a download and says which phase it
// is in. Every unit comes from the listen port's render (keptSynthesis.ts), the stitch and the
// container are renditionFile.ts's, the save is the page's, and what the reader sees of a phase
// is the panel's. Every effect is a parameter, so scripts/rendition-download-check.ts drives
// every phase with stubs [LAW:effects-at-boundaries].
//
// ONE WAY THROUGH [LAW:dataflow-not-control-flow]: rendering, as every unit is heard; encoding,
// as the encoder takes the samples; then saved, naming what the file leaves out, or failed with
// why [LAW:no-silent-failure]. A download withdrawn part way says nothing more: whatever
// settles after the withdrawal lands nowhere.

import { encodeFile, fileAudio, type AudioFile, type FileForm } from "./renditionFile";
import { unitRequest } from "./scheduler";
import type { SynthesisUnit, VoiceMap } from "./speechScript";
import type { ListenPort, RenderedUnit } from "./synthesisClient";
import { scriptLayout } from "./timeline";
import type { PcmFormat } from "./unitPlayer";

// [LAW:types-are-the-program] Where a download is. `made` counts units heard of `total`;
// `missing` names the units the file leaves out because the voice failed on them.
export type DownloadPhase =
  | { readonly kind: "rendering"; readonly made: number; readonly total: number }
  | { readonly kind: "encoding"; readonly fraction: number }
  | { readonly kind: "saved"; readonly name: string; readonly missing: ReadonlyArray<number> }
  | { readonly kind: "failed"; readonly message: string };

export interface DownloadConfig {
  readonly port: Pick<ListenPort, "render">;
  readonly script: ReadonlyArray<SynthesisUnit>;
  readonly voices: VoiceMap;
  readonly format: PcmFormat;
  // The file's name without its extension: the form decides that.
  readonly name: string;
  readonly form: () => Promise<FileForm>;
  readonly encode: typeof encodeFile;
  readonly save: (file: AudioFile, name: string) => void;
  readonly onPhase: (phase: DownloadPhase) => void;
}

// Starts a download; returns its withdrawal.
export const startDownload = (config: DownloadConfig): (() => void) => {
  const { port, script, voices, format, onPhase } = config;
  const units = new Map<number, RenderedUnit>();
  let live = true;
  const say = (phase: DownloadPhase): void => {
    if (live) onPhase(phase);
  };

  const finish = async (): Promise<void> => {
    const audio = fileAudio(scriptLayout(script), units, format);
    say({ kind: "encoding", fraction: 0 });
    const form = await config.form();
    const file = await config.encode(audio, format, form, (fraction) => say({ kind: "encoding", fraction }));
    if (!live) return;
    const name = `${config.name}${file.extension}`;
    config.save(file, name);
    say({ kind: "saved", name, missing: audio.missing });
  };

  // Every unit heard, once: the file is made. Asked after every unit and once at the start, so a
  // script with no units is a file of no audio, not a render that never ends.
  let finished = false;
  const whenWhole = (): void => {
    if (finished || units.size < script.length) return;
    finished = true;
    finish().catch((error: unknown) => say({ kind: "failed", message: error instanceof Error ? error.message : String(error) }));
  };

  say({ kind: "rendering", made: 0, total: script.length });
  const withdraw = port.render(
    script.map((_, unitId) => unitRequest(script, voices, unitId)),
    (unit) => {
      units.set(unit.unitId, unit);
      say({ kind: "rendering", made: units.size, total: script.length });
      whenWhole();
    },
  );
  whenWhole();
  return () => {
    live = false;
    withdraw();
  };
};
