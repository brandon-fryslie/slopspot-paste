// [LAW:decomposition] The synthesis protocol: every message that crosses between the page
// and the synthesis worker, as one closed pair of unions. One sentence, no "and": this
// module names the conversation. It performs nothing — the worker-side interpreter is
// synthesisHandler.ts, the page-side speaker is synthesisClient.ts — and it holds no state,
// so both ends import the same file and the compiler is the one enforcer of what may be
// said in which direction [LAW:types-are-the-program] [LAW:single-enforcer].
//
// WHY THE WORKER OWNS THE TOKENIZER SEAM. The speech script (speechScript.ts) cuts text into
// units under a TOKEN budget, and the only thing that can count Pocket TTS tokens is the
// SentencePiece model that ships with the weights — which the worker holds. So the script is
// derived where the tokenizer is: the page sends utterances, the worker answers with units.
// A per-string round trip would cost hundreds of messages per paste; one message per paste
// costs one.
//
// WHY THERE IS NO setVoice. The manifest hosts six voices at half a megabyte each; the worker
// loads all of them beside the weights, so a synthesize request names its voice as a value
// and there is no "voice not loaded" state to reject [LAW:dataflow-not-control-flow]. Cost,
// stated once: 3.3 MB on top of the 236 MB weights, downloaded once per device.
//
// CONTRACTS THE TYPES CANNOT CARRY, stated here so both ends read the same sentence:
//  - A fresh worker probes on its own; its first message is always `capability`, and no
//    byte of model is fetched before the page says `load`.
//  - Every `synthesize` gets exactly one terminal message — `done`, `cancelled` or `failed` —
//    after zero or more `audio` frames for the same unitId. Frames before a `failed` are
//    void: the unit's audio is the frames before a `done`, and nothing else.
//  - `cancel` is idempotent: a cancel for a unit that already has its terminal message is
//    the ordinary race of asynchronous messaging (the page cancels as `done` is in flight)
//    and produces nothing.
//  - `unitId` is the page's to choose, and the page's two requesters share the port: the
//    script's units are 0 to N-1, the scheduler's; a voice preview takes an id below zero
//    (voicePreview.ts), so each requester knows a message for the other's unit by its sign
//    alone. A unit is in flight from its `synthesize` until it is cancelled or has its
//    terminal message. Two requests for one id in flight at once is a
//    page bug and the second is refused as `failed{duplicate-unit}`; a request after a cancel
//    for the same id queues behind the cancelled job, whose terminal is posted first.
//  - A message legal only in a phase the worker is not in is answered with `refused`, which
//    names the phase, so a sequencing bug at the page surfaces as data rather than as a
//    worker that went quiet [LAW:no-silent-failure].
//  - `dispose` is answered with one `disposed`, posted once the worker holds no model —
//    after the running unit's terminal message and the model's release, at once when there
//    is nothing to release — so the page terminates the worker on a fact, not a guess. A
//    second `dispose` produces nothing.

import type { AssetFailure, AssetProgress } from "./modelAssetLoader";
import type { VoiceId } from "./modelAssets";
import type { Utterance } from "./speech";
import type { UnitReport } from "./speechManifest";
import type { SynthesisUnit, UnitText } from "./speechScript";

// The one backend the q35.1 spike shipped: jax-js's WebGPU path. Its single-threaded Wasm
// path ran at 1.03x real time on an M2 Max, so it is not offered and there is no order to
// fall back through; a device without WebGPU is `unsupported` and keeps the Web Speech
// voice [LAW:no-mode-explosion].
export type Backend = "webgpu";

// Why a device cannot run the model, decided before any download. The weights are fp16, so
// a WebGPU adapter without shader-f16 is as unsupported as no adapter at all.
export type UnsupportedReason =
  | { readonly kind: "no-webgpu" }
  | { readonly kind: "no-adapter" }
  | { readonly kind: "no-f16" }
  | { readonly kind: "no-device"; readonly message: string };

export type Support =
  | { readonly kind: "supported"; readonly backend: Backend }
  | { readonly kind: "unsupported"; readonly reason: UnsupportedReason };

// A load that did not end in a model: an asset that could not be fetched or verified
// (typed by the loader), or the runtime throwing while building the model from verified
// bytes. Both leave the worker `idle` so the page may `load` again.
export type LoadFailure = AssetFailure | { readonly kind: "runtime"; readonly message: string };

// Why a unit's synthesis did not end in `done`.
export type UnitFailure =
  | { readonly kind: "duplicate-unit" }
  // The generation loop ran to its frame cap without the model signalling end of speech:
  // the model is looping, not speaking, and the frames streamed so far are void.
  | { readonly kind: "frame-cap"; readonly frames: number }
  | { readonly kind: "runtime"; readonly message: string };

// The worker's coarse phase, named in `refused` so a sequencing bug reads as a fact.
export type Phase = "probing" | "unsupported" | "idle" | "loading" | "ready" | "disposed";

export type ToWorker =
  | { readonly kind: "load" }
  | { readonly kind: "script"; readonly id: number; readonly utterances: ReadonlyArray<Utterance> }
  // The fed text and its source slice: what the model says and the words it is timed against.
  | { readonly kind: "synthesize"; readonly unitId: number; readonly text: UnitText; readonly voice: VoiceId }
  | { readonly kind: "cancel"; readonly unitId: number }
  | { readonly kind: "dispose" };

export type FromWorker =
  | { readonly kind: "capability"; readonly support: Support }
  | { readonly kind: "progress"; readonly progress: AssetProgress }
  | { readonly kind: "ready"; readonly backend: Backend; readonly modelVersion: string }
  | { readonly kind: "load-failed"; readonly failure: LoadFailure }
  | { readonly kind: "script"; readonly id: number; readonly units: ReadonlyArray<SynthesisUnit> }
  // One decoded generation step: FRAME_MS of PCM at SAMPLE_RATE, transferred, not copied.
  | { readonly kind: "audio"; readonly unitId: number; readonly frameIndex: number; readonly pcm: Float32Array<ArrayBuffer> }
  // `report` is exactly what speechManifest.addUnit admits; `elapsedMs` is how long the
  // generation took, so the page can read the real-time factor off the first unit.
  | { readonly kind: "done"; readonly unitId: number; readonly report: UnitReport; readonly elapsedMs: number }
  | { readonly kind: "cancelled"; readonly unitId: number }
  | { readonly kind: "failed"; readonly unitId: number; readonly reason: UnitFailure }
  | { readonly kind: "refused"; readonly request: ToWorker; readonly phase: Phase }
  // The worker's last word: nothing of the model remains on the device.
  | { readonly kind: "disposed" };
