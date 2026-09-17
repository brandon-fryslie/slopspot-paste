// [LAW:decomposition] The voice sample: a voice heard at once, from a recording of it made
// ahead. One sentence, no "and": this module names each voice's sample and plays one at a
// time. It makes no sample (scripts/render-voice-samples.ts renders them from the voices'
// own pinned embeddings on the model version the site hosts, with the very phrase the live
// preview says), decides nothing about which audition a reader gets (the panel's) and never
// touches the listen's audio device: a sample plays through the page's own audio element.
//
// WHY A SAMPLE. The live preview (voicePreview.ts) needs the model on the device, warm — and
// the reader who most needs to hear the voices is the one deciding whether to download 240
// MB of it. A sample is a few seconds of AAC, one request, playable on every device the page
// opens on, the voice-that-cannot-run-here included.
//
// PINNED LIKE THE MODEL [LAW:one-source-of-truth]. A sample's bytes are named in the
// manifest beside the voice they were rendered from (modelAssets.ts), and its path carries a
// prefix of its own SHA-256 as every model asset's does: new bytes are a new URL, an old
// cached copy is merely unused, and scripts/voice-sample-check.ts fails the build when the
// file at a manifest's path is missing or is not those bytes — a sample can never drift
// from the voice it stands for without the check saying so.
//
// [LAW:effects-at-boundaries] The audio element is a parameter, so the check drives the
// player over a stub; the page hands it `() => new Audio()`.

import { MODEL_ASSETS, SHA_PREFIX_CHARS, type VoiceId } from "./modelAssets";

export const SAMPLE_PREFIX = "/voices/";

// The sample's file name from its voice and its bytes' hash: what the renderer writes and
// what the page asks for, one rule.
export const sampleFile = (id: VoiceId, sha256: string): string => `${id}-${sha256.slice(0, SHA_PREFIX_CHARS)}.m4a`;

export const samplePath = (id: VoiceId): string => `${SAMPLE_PREFIX}${sampleFile(id, MODEL_ASSETS.voices[id].sample.sha256)}`;

// [LAW:types-are-the-program] What the player needs of an audio element: the four members
// it uses, so a stub is a small object and the page's HTMLAudioElement is one by structure.
export interface SampleAudio {
  src: string;
  play: () => Promise<void>;
  pause: () => void;
  addEventListener: (type: "ended" | "error", listener: () => void) => void;
  // Why the element failed, when it has: the browser's own word, for the console.
  readonly error: { readonly message: string } | null;
}

export interface SamplePlayerConfig {
  readonly Audio: () => SampleAudio;
  // The voice sounding, or null once it ends or is hushed; told on every change only.
  readonly onChange: (voice: VoiceId | null) => void;
}

export interface SamplePlayer {
  // The voice's sample, from its start, replacing whatever was sounding.
  readonly say: (voice: VoiceId) => void;
  readonly hush: () => void;
  readonly dispose: () => void;
}

export const createSamplePlayer = ({ Audio, onChange }: SamplePlayerConfig): SamplePlayer => {
  // [LAW:no-shared-mutable-globals] One element, owned here, and the voice it is sounding.
  const audio = Audio();
  let sounding: VoiceId | null = null;
  // [LAW:types-are-the-program] Which play is speaking, not which voice: a `say` for the
  // voice already sounding is a new play too, and the one it supersedes must not unlight it.
  let plays = 0;
  const settle = (voice: VoiceId | null): void => {
    if (voice === sounding) return;
    sounding = voice;
    onChange(voice);
  };
  audio.addEventListener("ended", () => settle(null));
  // The element's own failure — a decode that fails, a connection that drops mid-sample —
  // is said and the voice unlit, as a refused play is [LAW:no-silent-failure].
  audio.addEventListener("error", () => {
    // Only Chrome reliably fills the element's reason in; elsewhere it is the empty string.
    if (sounding !== null) console.warn(`voice sample: ${sounding} stopped — ${audio.error?.message?.trim() || "the element gave no reason"}`);
    settle(null);
  });
  const hush = (): void => {
    plays += 1;
    audio.pause();
    settle(null);
  };
  return {
    say: (voice) => {
      const play = (plays += 1);
      audio.pause();
      audio.src = samplePath(voice);
      settle(voice);
      // A play the browser refuses — no gesture behind it, a network the sample never came
      // over — is said, and the voice is unlit [LAW:no-silent-failure]. A play superseded
      // before it began (the pause or the new src of the next `say`, or a hush, rejects it)
      // is not a refusal of the play sounding now, even where both are the same voice.
      audio.play().catch((error: unknown) => {
        if (play !== plays) return;
        console.warn(`voice sample: ${voice} could not play`, error);
        settle(null);
      });
    },
    hush,
    dispose: hush,
  };
};
